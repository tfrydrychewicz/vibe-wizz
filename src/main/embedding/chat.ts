/**
 * Claude-based chat handler for the AI chat sidebar.
 * Performs knowledge base Q&A by injecting relevant note context into a system prompt.
 * Also supports agentic tool use: Claude can create/update/delete calendar events and action items.
 * Lazy singleton — instantiated on first use, replaced when the API key changes.
 */

import Anthropic from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import { getDatabase } from '../db/index'
import { parseMarkdownToTipTap } from '../transcription/postProcessor'
import { scheduleEmbedding } from './pipeline'

let _client: Anthropic | null = null
let _currentKey = ''

// Default chat model — overridable per-request
const DEFAULT_CHAT_MODEL = 'claude-sonnet-4-6'
// Haiku: fast and cheap for keyword extraction (query expansion)
const KEYWORD_MODEL = 'claude-haiku-4-5-20251001'

export const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-6',          label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6',        label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const

export type ChatModelId = typeof AVAILABLE_MODELS[number]['id']

const MAX_CONTEXT_CHARS = 8000
const MAX_TOOL_ITERATIONS = 10

export type CalendarEventContext = {
  id: number
  title: string
  start_at: string
  end_at: string
  attendees: string // raw JSON string of {name?, email?}[]
  linked_note_id: string | null
  linked_note_title: string | null
}

export type ActionItemContext = {
  id: string
  title: string
  status: string
  due_date: string | null
  assigned_entity_name: string | null
  source_note_id: string | null
  source_note_title: string | null
}

export type EntityContext = {
  id: string
  name: string
  type_name: string
}

export type ExecutedAction = {
  type:
    | 'created_event'
    | 'updated_event'
    | 'deleted_event'
    | 'created_action'
    | 'updated_action'
    | 'deleted_action'
    | 'created_note'
  payload: {
    id: number | string
    title?: string
    start_at?: string
    end_at?: string
    status?: string
    due_date?: string | null
    assigned_entity_name?: string | null
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const WIZZ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'create_calendar_event',
    description: 'Create a new calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_at: { type: 'string', description: 'ISO 8601 local time without Z, e.g. 2026-02-27T15:00' },
        end_at: { type: 'string', description: 'ISO 8601 local time without Z, e.g. 2026-02-27T16:00' },
        attendees: {
          type: 'array',
          description: 'Optional list of attendees',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
            },
          },
        },
      },
      required: ['title', 'start_at', 'end_at'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update fields on an existing calendar event. Resolve the event ID from the calendar context provided before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Calendar event ID (integer)' },
        title: { type: 'string' },
        start_at: { type: 'string', description: 'ISO 8601 local time without Z' },
        end_at: { type: 'string', description: 'ISO 8601 local time without Z' },
        attendees: {
          type: 'array',
          items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Delete a calendar event permanently. ALWAYS describe what you are about to delete in your response text and ask the user to confirm before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Calendar event ID (integer)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_action_item',
    description: 'Create a new action item / task.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Action item title' },
        due_date: { type: 'string', description: 'Optional ISO 8601 date, e.g. 2026-03-01' },
        assigned_entity_id: {
          type: 'string',
          description: 'Optional entity ID of the Person to assign this to',
        },
        source_note_id: {
          type: 'string',
          description: 'Optional note ID this action item comes from',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_action_item',
    description:
      'Update an existing action item. Resolve the item ID from the action items context provided before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Action item ID (UUID)' },
        title: { type: 'string' },
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'done', 'cancelled'],
          description: 'New status',
        },
        due_date: { type: 'string', description: 'ISO 8601 date or null to clear' },
        assigned_entity_id: { type: 'string', description: 'Entity ID of assignee, or null to clear' },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_action_item',
    description:
      'Delete an action item permanently. ALWAYS describe what you are about to delete in your response text and ask the user to confirm before calling this tool.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Action item ID (UUID)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'create_note',
    description:
      'Create a new note in the knowledge base. Use this when the user asks to create, write, draft, or generate a note, document, summary, or any piece of structured content. ' +
      'Format the content as Markdown: ## for headings, - for bullets, - [ ] for task checkboxes, **bold**, *italic*, `code`, ' +
      'and GFM tables (| Col | Col |\\n| --- | --- |\\n| cell | cell |) for structured data. ' +
      'The note will be rendered with full rich-text formatting in the editor.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Note title — short and descriptive' },
        content: {
          type: 'string',
          description:
            'Note body in Markdown. Use ## for section headings, - for bullet lists, - [ ] for actionable tasks, **bold** for emphasis. ' +
            'For structured/tabular data use GFM tables: | Header | Header |\\n| --- | --- |\\n| cell | cell |',
        },
      },
      required: ['title', 'content'],
    },
  },
]

// ── Tool executor ────────────────────────────────────────────────────────────

function executeTool(toolName: string, input: Record<string, unknown>): ExecutedAction {
  const db = getDatabase()

  switch (toolName) {
    case 'create_calendar_event': {
      const inp = input as { title: string; start_at: string; end_at: string; attendees?: { name?: string; email?: string }[] }
      const attendeesJson = JSON.stringify(inp.attendees ?? [])
      const now = new Date().toISOString()
      const result = db
        .prepare(
          `INSERT INTO calendar_events (title, start_at, end_at, attendees, synced_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(inp.title, inp.start_at, inp.end_at, attendeesJson, now)
      const row = db
        .prepare('SELECT id, title, start_at, end_at FROM calendar_events WHERE id = ?')
        .get(result.lastInsertRowid) as { id: number; title: string; start_at: string; end_at: string }
      return { type: 'created_event', payload: row }
    }

    case 'update_calendar_event': {
      const { id, ...updates } = input as {
        id: number
        title?: string
        start_at?: string
        end_at?: string
        attendees?: { name?: string; email?: string }[]
      }
      const sets: string[] = []
      const params: unknown[] = []
      if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title) }
      if (updates.start_at !== undefined) { sets.push('start_at = ?'); params.push(updates.start_at) }
      if (updates.end_at !== undefined) { sets.push('end_at = ?'); params.push(updates.end_at) }
      if (updates.attendees !== undefined) { sets.push('attendees = ?'); params.push(JSON.stringify(updates.attendees)) }
      if (sets.length) {
        params.push(id)
        db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`)
          .run(...(params as (string | number | null)[]))
      }
      const row = db
        .prepare('SELECT id, title, start_at, end_at FROM calendar_events WHERE id = ?')
        .get(id) as { id: number; title: string; start_at: string; end_at: string } | undefined
      if (!row) throw new Error(`Calendar event with id ${id} not found`)
      return { type: 'updated_event', payload: row }
    }

    case 'delete_calendar_event': {
      const { id } = input as { id: number }
      const row = db
        .prepare('SELECT id, title, start_at, end_at FROM calendar_events WHERE id = ?')
        .get(id) as { id: number; title: string; start_at: string; end_at: string } | undefined
      if (!row) throw new Error(`Calendar event with id ${id} not found`)
      db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
      return { type: 'deleted_event', payload: row }
    }

    case 'create_action_item': {
      const inp = input as {
        title: string
        due_date?: string
        assigned_entity_id?: string
        source_note_id?: string
      }
      const id = randomUUID()
      db.prepare(
        `INSERT INTO action_items (id, title, source_note_id, assigned_entity_id, due_date, extraction_type, confidence)
         VALUES (?, ?, ?, ?, ?, 'manual', 1.0)`,
      ).run(id, inp.title, inp.source_note_id ?? null, inp.assigned_entity_id ?? null, inp.due_date ?? null)
      const row = db
        .prepare(
          `SELECT ai.id, ai.title, ai.status, ai.due_date, e.name AS assigned_entity_name
           FROM action_items ai
           LEFT JOIN entities e ON e.id = ai.assigned_entity_id
           WHERE ai.id = ?`,
        )
        .get(id) as { id: string; title: string; status: string; due_date: string | null; assigned_entity_name: string | null }
      return { type: 'created_action', payload: row }
    }

    case 'update_action_item': {
      const { id, ...updates } = input as {
        id: string
        title?: string
        status?: string
        due_date?: string | null
        assigned_entity_id?: string | null
      }
      const sets: string[] = []
      const params: unknown[] = []
      if (updates.title !== undefined) { sets.push('title = ?'); params.push(updates.title) }
      if (updates.status !== undefined) {
        sets.push('status = ?')
        params.push(updates.status)
        if (updates.status === 'done' || updates.status === 'cancelled') {
          sets.push("completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        } else {
          sets.push('completed_at = NULL')
        }
      }
      if ('due_date' in updates) { sets.push('due_date = ?'); params.push(updates.due_date ?? null) }
      if ('assigned_entity_id' in updates) { sets.push('assigned_entity_id = ?'); params.push(updates.assigned_entity_id ?? null) }
      if (sets.length) {
        params.push(id)
        db.prepare(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`)
          .run(...(params as (string | number | null)[]))
      }
      const row = db
        .prepare(
          `SELECT ai.id, ai.title, ai.status, ai.due_date, e.name AS assigned_entity_name
           FROM action_items ai
           LEFT JOIN entities e ON e.id = ai.assigned_entity_id
           WHERE ai.id = ?`,
        )
        .get(id) as { id: string; title: string; status: string; due_date: string | null; assigned_entity_name: string | null } | undefined
      if (!row) throw new Error(`Action item with id ${id} not found`)
      return { type: 'updated_action', payload: row }
    }

    case 'delete_action_item': {
      const { id } = input as { id: string }
      const row = db
        .prepare('SELECT id, title FROM action_items WHERE id = ?')
        .get(id) as { id: string; title: string } | undefined
      if (!row) throw new Error(`Action item with id ${id} not found`)
      db.prepare('DELETE FROM action_items WHERE id = ?').run(id)
      return { type: 'deleted_action', payload: row }
    }

    case 'create_note': {
      const inp = input as { title: string; content: string }
      const id = randomUUID()
      const contentNodes = parseMarkdownToTipTap(inp.content)
      const doc = { type: 'doc', content: contentNodes }
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO notes (id, title, body, body_plain, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, inp.title, JSON.stringify(doc), inp.content, now)
      // Fire-and-forget: trigger NER + action extraction + embeddings
      scheduleEmbedding(id)
      return { type: 'created_note', payload: { id, title: inp.title } }
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatCalendarEvent(ev: CalendarEventContext): string {
  const start = new Date(ev.start_at)
  const end = new Date(ev.end_at)
  const dateStr = start.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const startTime = start.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
  const endTime = end.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
  let line = `- [id:${ev.id}] "${ev.title}" on ${dateStr} ${startTime}–${endTime}`
  try {
    const attendees = JSON.parse(ev.attendees) as { name?: string; email?: string }[]
    if (attendees.length > 0) {
      line += ` · attendees: ${attendees.map((a) => a.name || a.email || '?').join(', ')}`
    }
  } catch {
    // ignore malformed JSON
  }
  if (ev.linked_note_title) line += ` [notes: "${ev.linked_note_title}"]`
  return line
}

function formatActionItem(item: ActionItemContext): string {
  let line = `- [id:${item.id}] [${item.status}] "${item.title}"`
  if (item.due_date) line += ` (due: ${item.due_date})`
  if (item.assigned_entity_name) line += ` → ${item.assigned_entity_name}`
  if (item.source_note_title) line += ` (from: "${item.source_note_title}")`
  return line
}

/** Update (or clear) the Anthropic client when the API key changes. */
export function setChatAnthropicKey(apiKey: string): void {
  if (apiKey === _currentKey) return
  _client = apiKey ? new Anthropic({ apiKey }) : null
  _currentKey = apiKey
}

/**
 * Extract search keywords from a question using Claude Haiku, with optional
 * conversation history so follow-up questions ("and when was that?") resolve
 * to the right topic ("Bifrost", "meeting") based on prior context.
 *
 * Returns base-form keywords in any language without stop-word lists.
 * Falls back to splitting the raw query on whitespace if the API call fails.
 */
export async function extractSearchKeywords(
  question: string,
  recentHistory?: { role: 'user' | 'assistant'; content: string }[],
  model = KEYWORD_MODEL,
): Promise<string[]> {
  if (!_client) return question.split(/\s+/).filter((w) => w.length >= 3)

  // Build a short conversation snippet (last 4 messages) so Haiku can resolve
  // pronouns and follow-ups like "a kiedy to bylo?" → keywords from prior topic
  let contextBlock = ''
  if (recentHistory && recentHistory.length > 0) {
    const snippet = recentHistory
      .slice(-4)
      .map((m) => `[${m.role === 'user' ? 'User' : 'Assistant'}]: ${m.content.slice(0, 300)}`)
      .join('\n')
    contextBlock = `Conversation so far:\n${snippet}\n\n`
  }

  try {
    const response = await _client.messages.create({
      model: model,
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content:
            `${contextBlock}` +
            'Based on the conversation above and the latest question, extract 3-6 search keywords ' +
            'that would help locate relevant notes in a personal knowledge base. ' +
            'Return ONLY the keywords in their base/dictionary form, space-separated, no punctuation, no explanation. ' +
            'Preserve proper nouns exactly as written.\n\n' +
            `Latest question: ${question}\n\nKeywords:`,
        },
      ],
    })

    const block = response.content[0]
    if (block.type !== 'text') return question.split(/\s+/).filter((w) => w.length >= 3)

    return block.text
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[,;.]/g, ''))
      .filter((w) => w.length >= 2)
  } catch {
    return question.split(/\s+/).filter((w) => w.length >= 3)
  }
}

/**
 * Expand a search query into related terms and concepts using Claude Haiku.
 * Used for query expansion in semantic search — generates synonyms and related
 * concepts that help find relevant notes even when exact keywords aren't present.
 *
 * Example: "who has blockers?" → ["blocker", "blocked", "impediment", "stuck"]
 *
 * Falls back to splitting on whitespace if the API call fails or client is not set.
 */
export async function expandQueryConcepts(query: string, model = KEYWORD_MODEL): Promise<string[]> {
  if (!_client) return query.split(/\s+/).filter((w) => w.length >= 3)

  try {
    const response = await _client.messages.create({
      model: model,
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content:
            'For the search query below, generate 4-8 closely related terms: synonyms, ' +
            'related concepts, and common alternative phrasings that would help find relevant notes. ' +
            'Include the key terms from the original query. ' +
            'Return ONLY the terms, space-separated, no explanation. ' +
            'Always respond in the same language as the query.\n\n' +
            `Query: ${query}\n\nTerms:`,
        },
      ],
    })

    const block = response.content[0]
    if (block.type !== 'text') return query.split(/\s+/).filter((w) => w.length >= 3)

    return block.text
      .trim()
      .split(/\s+/)
      .map((w) => w.replace(/[,;.]/g, ''))
      .filter((w) => w.length >= 2)
  } catch {
    return query.split(/\s+/).filter((w) => w.length >= 3)
  }
}

/**
 * Re-rank search results using Claude Haiku as a relevance judge.
 * Sends all candidates in a single batch call; receives one integer score per result.
 * Returns the input array sorted by descending relevance score.
 * Falls back to the original order on API failure or if the client is not set.
 */
export async function reRankResults<T extends { title: string; excerpt: string | null }>(
  query: string,
  results: T[],
  model = KEYWORD_MODEL,
): Promise<T[]> {
  if (!_client || results.length <= 1) return results

  const docList = results
    .map((r, i) => `[${i}] "${r.title}"\n${(r.excerpt ?? '').slice(0, 250)}`)
    .join('\n\n')

  try {
    const response = await _client.messages.create({
      model: model,
      max_tokens: 80,
      messages: [
        {
          role: 'user',
          content:
            `Query: "${query}"\n\n` +
            "Rate each document's relevance to the query (0=not relevant, 10=highly relevant).\n\n" +
            `${docList}\n\n` +
            'Output ONLY a JSON array of integers, one per document, in order. Example: [8,3,6,1]',
        },
      ],
    })

    const block = response.content[0]
    if (block.type !== 'text') return results

    const match = block.text.match(/\[[\d,\s]+\]/)
    if (!match) return results

    const scores = JSON.parse(match[0]) as number[]
    if (!Array.isArray(scores) || scores.length !== results.length) return results

    return results
      .map((r, i) => ({ result: r, score: scores[i] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .map(({ result }) => result)
  } catch {
    return results
  }
}

/**
 * Send a chat message with optional knowledge base context.
 *
 * Supports Claude tool use: if Claude decides to call a calendar or action item
 * tool, the tool is executed immediately and the result is fed back to Claude
 * (looping up to MAX_TOOL_ITERATIONS) before returning the final response.
 *
 * contextNotes: top search results injected into the system prompt.
 * calendarEvents: upcoming/recent calendar events for temporal awareness.
 * actionItems: open/in-progress action items.
 *
 * Returns { content, actions } where actions is the list of DB mutations performed.
 * Throws on API error — caller should handle gracefully.
 */
export type AttachedFilePayload = {
  name: string
  content: string                             // plain text, or base64 (no data: prefix) for PDFs
  mimeType: 'application/pdf' | 'text/plain'
}

export async function sendChatMessage(
  messages: { role: 'user' | 'assistant'; content: string }[],
  contextNotes: { id: string; title: string; excerpt: string }[],
  calendarEvents: CalendarEventContext[] = [],
  actionItems: ActionItemContext[] = [],
  images?: { dataUrl: string; mimeType: string }[],
  model: ChatModelId = DEFAULT_CHAT_MODEL,
  files?: AttachedFilePayload[],
  entityContext: EntityContext[] = [],
): Promise<{ content: string; actions: ExecutedAction[] }> {
  if (!_client) throw new Error('Anthropic client not initialized — set the API key first')

  let systemPrompt =
    'You are Wizz, an AI assistant built into an engineering manager\'s personal knowledge base. ' +
    'You help the user find information from their notes, understand patterns across meetings, ' +
    'and think through problems using their accumulated context.\n\n' +
    'Always reply in the same language the user writes in.\n\n' +
    'Be concise and actionable. When you don\'t have relevant context, say so rather than guessing.\n\n' +
    'You have tools available to create, update, and delete calendar events and action items, and to create notes. ' +
    'Use them when the user asks you to make a change (schedule, add, create, write, draft, generate, mark, update, move, cancel, delete, etc.). ' +
    'For creates and updates: execute immediately without asking. ' +
    'For deletes: describe what you are about to delete and ask the user to confirm before calling the delete tool. ' +
    'When creating a note, generate rich, well-structured Markdown content — use headings, bullet lists, task checkboxes, and GFM tables (| Col | Col |\\n| --- | --- |\\n| val | val |) as appropriate.'

  if (contextNotes.length > 0) {
    let contextStr = contextNotes
      .map((n) => `Note: "${n.title}"\n${n.excerpt}`)
      .join('\n\n---\n\n')

    if (contextStr.length > MAX_CONTEXT_CHARS) {
      contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS) + '…'
    }

    systemPrompt +=
      '\n\nHere are relevant notes from the user\'s knowledge base, ' +
      'including related notes retrieved via knowledge graph connections (wiki-links and shared entity mentions):\n\n' +
      contextStr +
      '\n\nWhen referencing information from a specific note, cite it as [Note: "Title"]. ' +
      'Use the exact note title as it appears above.'
  }

  if (calendarEvents.length > 0) {
    const evLines = calendarEvents.map(formatCalendarEvent).join('\n')
    systemPrompt +=
      '\n\nHere are the user\'s upcoming and recent calendar events (past 7 days + next 30 days). ' +
      'Each entry includes its ID in [id:N] — use the ID when calling calendar tools:\n' +
      evLines
  }

  if (actionItems.length > 0) {
    const itemLines = actionItems.map(formatActionItem).join('\n')
    systemPrompt +=
      '\n\nHere are the user\'s open and in-progress action items. ' +
      'Each entry includes its ID in [id:...] — use the ID when calling action item tools:\n' +
      itemLines
  }

  if (entityContext.length > 0) {
    const entityLines = entityContext
      .map((e) => `- [id:${e.id}] @${e.name} (type: ${e.type_name})`)
      .join('\n')
    systemPrompt +=
      '\n\nEntities mentioned in this conversation. When assigning action items or referencing people/projects, ' +
      'use the entity ID from [id:...]. Always confirm the entity type is appropriate for the operation ' +
      '(e.g. only assign tasks to Person-type entities):\n' +
      entityLines
  }

  // Build a mutable message list for the tool loop.
  // The loop may append assistant tool-use blocks and user tool-result blocks.
  // If images or files are provided, attach them to the last user message as content blocks.
  const lastUserIndex = [...messages].map((m) => m.role).lastIndexOf('user')
  const loopMessages: Anthropic.MessageParam[] = messages.map((m, i) => {
    const hasImages = images && images.length > 0
    const hasFiles = files && files.length > 0
    if (i === lastUserIndex && (hasImages || hasFiles)) {
      return {
        role: 'user' as const,
        content: [
          ...(hasImages ? images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: img.dataUrl.includes(',') ? img.dataUrl.split(',')[1] : img.dataUrl,
            },
          })) : []),
          ...(hasFiles ? files.map((f) => ({
            type: 'document' as const,
            source: f.mimeType === 'application/pdf'
              ? { type: 'base64' as const, media_type: 'application/pdf' as const, data: f.content }
              : { type: 'text' as const, media_type: 'text/plain' as const, data: f.content },
          })) : []),
          { type: 'text' as const, text: m.content || '(see attached file)' },
        ],
      }
    }
    return { role: m.role as 'user' | 'assistant', content: m.content }
  })

  const actions: ExecutedAction[] = []
  let finalText = ''

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await _client.messages.create({
      model,
      max_tokens: 4000,
      system: systemPrompt,
      tools: WIZZ_TOOLS,
      messages: loopMessages,
    })

    if (response.stop_reason !== 'tool_use') {
      // Terminal response — extract text content
      const textBlock = response.content.find((b) => b.type === 'text')
      finalText = textBlock?.type === 'text' ? textBlock.text.trim() : ''
      break
    }

    // Append assistant turn (may include text + tool_use blocks)
    loopMessages.push({ role: 'assistant', content: response.content })

    // Execute each tool call and collect results
    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue

      let resultContent: string
      let isError = false
      try {
        const action = executeTool(block.name, block.input as Record<string, unknown>)
        actions.push(action)
        resultContent = JSON.stringify(action.payload)
      } catch (err) {
        isError = true
        resultContent = err instanceof Error ? err.message : String(err)
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: resultContent,
        is_error: isError,
      })
    }

    loopMessages.push({ role: 'user', content: toolResults })
  }

  return { content: finalText, actions }
}
