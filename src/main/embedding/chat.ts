/**
 * Claude-based chat handler for the AI chat sidebar.
 * Performs knowledge base Q&A by injecting relevant note context into a system prompt.
 * Lazy singleton — instantiated on first use, replaced when the API key changes.
 */

import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
let _currentKey = ''

// Sonnet: better reasoning quality for interactive synthesis
const CHAT_MODEL = 'claude-sonnet-4-6'
// Haiku: fast and cheap for keyword extraction (query expansion)
const KEYWORD_MODEL = 'claude-haiku-4-5-20251001'

const MAX_CONTEXT_CHARS = 8000

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

function formatCalendarEvent(ev: CalendarEventContext): string {
  const start = new Date(ev.start_at)
  const end = new Date(ev.end_at)
  const dateStr = start.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  const startTime = start.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
  const endTime = end.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
  let line = `- "${ev.title}" on ${dateStr} ${startTime}–${endTime}`
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
  let line = `- [${item.status}] "${item.title}"`
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
      model: KEYWORD_MODEL,
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
 * Send a chat message with optional knowledge base context.
 *
 * contextNotes: top search results injected into the system prompt.
 * calendarEvents: upcoming/recent calendar events for temporal awareness.
 * actionItems: open/in-progress action items.
 * Claude is instructed to cite notes as [Note: "Title"] and to reply
 * in the same language the user used.
 *
 * Returns the assistant's response text.
 * Throws on API error — caller should handle gracefully.
 */
export async function sendChatMessage(
  messages: { role: 'user' | 'assistant'; content: string }[],
  contextNotes: { id: string; title: string; excerpt: string }[],
  calendarEvents: CalendarEventContext[] = [],
  actionItems: ActionItemContext[] = [],
): Promise<string> {
  if (!_client) throw new Error('Anthropic client not initialized — set the API key first')

  let systemPrompt =
    'You are Wizz, an AI assistant built into an engineering manager\'s personal knowledge base. ' +
    'You help the user find information from their notes, understand patterns across meetings, ' +
    'and think through problems using their accumulated context.\n\n' +
    'Always reply in the same language the user writes in.\n\n' +
    'Be concise and actionable. When you don\'t have relevant context, say so rather than guessing.'

  if (contextNotes.length > 0) {
    let contextStr = contextNotes
      .map((n) => `Note: "${n.title}"\n${n.excerpt}`)
      .join('\n\n---\n\n')

    if (contextStr.length > MAX_CONTEXT_CHARS) {
      contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS) + '…'
    }

    systemPrompt +=
      '\n\nHere are relevant notes from the user\'s knowledge base:\n\n' +
      contextStr +
      '\n\nWhen referencing information from a specific note, cite it as [Note: "Title"]. ' +
      'Use the exact note title as it appears above.'
  }

  if (calendarEvents.length > 0) {
    const evLines = calendarEvents.map(formatCalendarEvent).join('\n')
    systemPrompt +=
      '\n\nHere are the user\'s upcoming and recent calendar events (past 7 days + next 30 days):\n' +
      evLines
  }

  if (actionItems.length > 0) {
    const itemLines = actionItems.map(formatActionItem).join('\n')
    systemPrompt +=
      '\n\nHere are the user\'s open and in-progress action items:\n' +
      itemLines
  }

  const response = await _client.messages.create({
    model: CHAT_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages,
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude')
  return block.text.trim()
}
