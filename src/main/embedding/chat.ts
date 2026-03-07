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
import { ENTITY_TOKEN_RE } from '../utils/tokenFormat'
import { getCurrentDateString } from '../utils/date'
import { callWithFallback } from '../ai/modelRouter'

// Anthropic built-in web search tool — executed server-side, no client implementation needed
const WEB_SEARCH_TOOL: Anthropic.Messages.WebSearchTool20260209 = {
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 5,
}

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
  assigned_entity_id: string | null
  assigned_entity_name: string | null
  project_entity_id: string | null
  project_name: string | null
  source_note_id: string | null
  source_note_title: string | null
}

export type EntityContext = {
  id: string
  name: string
  type_name: string
}

export type EntityLinkedNote = {
  id: string
  title: string
  excerpt: string
}

export type ResolvedField = {
  name: string
  value: string  // human-readable; refs formatted as "{{entity:uuid:Name}}" or "{{note:uuid:Name}}"
}

/**
 * A block of note content the user copied from the editor and pasted into the
 * AI chat or inline-AI prompt.  Mirrors the renderer-side NoteSelectionAttachment
 * type (kept separate because main-process tsconfig excludes renderer sources).
 */
export type NoteSelectionAttachment = {
  noteId: string
  noteTitle: string
  blockStart: number
  blockEnd: number
  selectedText: string
}

export type RichEntityContext = {
  id: string
  name: string
  type_name: string
  depth: number  // 0 = directly mentioned, 1 = 1-hop ref, 2 = 2-hop ref
  fields: ResolvedField[]
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
    | 'created_entity'
    | 'updated_entity'
    | 'ensured_action_created'   // ensure_action_item_for_task — new row inserted
    | 'ensured_action_found'     // ensure_action_item_for_task — existing row found
  payload: {
    id: number | string
    /** Returned to Claude as `action_item_id` so it can chain into update_action_item */
    action_item_id?: string
    /** True when ensure_action_item_for_task created a new row (false = existing found) */
    created?: boolean
    title?: string
    name?: string
    type_name?: string
    start_at?: string
    end_at?: string
    status?: string
    due_date?: string | null
    assigned_entity_name?: string | null
  }
}

// ── Entity tool helpers ───────────────────────────────────────────────────────

type StoredFieldDef = {
  name: string
  type: 'text' | 'email' | 'date' | 'select' | 'text_list' | 'entity_ref' | 'entity_ref_list' | 'note_ref' | 'computed'
  options?: string[]
  entity_type?: string
  query?: string
}

function slugifyTypeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')
}

function fieldToJsonSchema(field: StoredFieldDef): Record<string, unknown> | null {
  switch (field.type) {
    case 'text':
      return { type: 'string', description: `${field.name}` }
    case 'email':
      return { type: 'string', description: `${field.name} (email address)` }
    case 'date':
      return { type: 'string', description: `${field.name} (ISO 8601 date, e.g. 2026-03-01)` }
    case 'select':
      return field.options && field.options.length > 0
        ? { type: 'string', enum: field.options, description: `${field.name}` }
        : { type: 'string', description: `${field.name}` }
    case 'text_list':
      return { type: 'array', items: { type: 'string' }, description: `${field.name} (list of text values)` }
    case 'entity_ref':
      return { type: 'string', description: `${field.name} — entity ID (UUID) of the referenced ${field.entity_type ?? 'entity'}` }
    case 'entity_ref_list':
      return { type: 'array', items: { type: 'string' }, description: `${field.name} — list of entity IDs (UUIDs) of referenced ${field.entity_type ?? 'entity'} records` }
    case 'note_ref':
      return { type: 'string', description: `${field.name} — note ID (UUID)` }
    case 'computed':
      return null  // skip — read-only computed values
    default:
      return { type: 'string', description: `${field.name}` }
  }
}

/**
 * Build one `create_<slug>` Anthropic tool per entity type in the DB.
 * Returns both the tool definitions and a slug→typeId map for execution.
 */
function buildEntityTools(db: ReturnType<typeof getDatabase>): {
  tools: Anthropic.Tool[]
  slugToTypeId: Map<string, string>
  slugToTypeName: Map<string, string>
} {
  const rows = db.prepare('SELECT id, name, schema FROM entity_types').all() as {
    id: string
    name: string
    schema: string
  }[]

  const tools: Anthropic.Tool[] = []
  const slugToTypeId = new Map<string, string>()
  const slugToTypeName = new Map<string, string>()

  for (const row of rows) {
    const slug = slugifyTypeName(row.name)
    slugToTypeId.set(slug, row.id)
    slugToTypeName.set(slug, row.name)

    let fields: StoredFieldDef[] = []
    try {
      const schema = JSON.parse(row.schema) as { fields?: StoredFieldDef[] }
      fields = schema.fields ?? []
    } catch { /* ignore malformed schema */ }

    const properties: Record<string, unknown> = {
      name: { type: 'string', description: `${row.name} name` },
    }

    for (const field of fields) {
      const jsonSchema = fieldToJsonSchema(field)
      if (jsonSchema) properties[field.name] = jsonSchema
    }

    tools.push({
      name: `create_${slug}`,
      description: `Create a new ${row.name} entity in the knowledge base.`,
      input_schema: {
        type: 'object',
        properties,
        required: ['name'],
      },
    })

    // Build the edit tool: id is required; name and all non-computed fields are optional.
    // 'properties' already contains 'name' plus all editable field schemas.
    const editProperties: Record<string, unknown> = {
      id: { type: 'string', description: `ID (UUID) of the ${row.name} entity to update` },
      ...properties,
    }

    tools.push({
      name: `edit_${slug}`,
      description:
        `Update an existing ${row.name} entity. ` +
        `Resolve the entity ID from the context provided before calling this. ` +
        `Only supply the fields you want to change; omitted fields are left unchanged.`,
      input_schema: {
        type: 'object',
        properties: editProperties,
        required: ['id'],
      },
    })
  }

  return { tools, slugToTypeId, slugToTypeName }
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
        project_entity_id: {
          type: 'string',
          description: 'Optional entity ID of the Project this task belongs to',
        },
        contexts: {
          type: 'array',
          items: { type: 'string' },
          description: 'GTD context tags, e.g. ["@computer", "@phone"]',
        },
        energy_level: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Energy level required for this task',
        },
        is_waiting_for: {
          type: 'boolean',
          description: 'True if this task is blocked waiting on someone else',
        },
        parent_id: {
          type: 'string',
          description: 'Optional parent action item ID (for sub-tasks)',
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
          enum: ['open', 'in_progress', 'done', 'cancelled', 'someday'],
          description: 'New status',
        },
        due_date: { type: 'string', description: 'ISO 8601 date or null to clear' },
        assigned_entity_id: { type: 'string', description: 'Entity ID of assignee, or null to clear' },
        project_entity_id: { type: 'string', description: 'Entity ID of project, or null to clear' },
        contexts: {
          type: 'array',
          items: { type: 'string' },
          description: 'GTD context tags, e.g. ["@computer"]',
        },
        energy_level: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Energy level required',
        },
        is_waiting_for: {
          type: 'boolean',
          description: 'True if blocked waiting on someone else',
        },
        parent_id: { type: 'string', description: 'Parent task ID for sub-tasks, or null to clear' },
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
    name: 'ensure_action_item_for_task',
    description:
      'Find or create an action item that corresponds to a single task from a pasted note selection. ' +
      'Call this BEFORE update_action_item for each task you need to modify. ' +
      'When the note selection contains multiple tasks, call this tool once per task (with its individual task_text) ' +
      'and then call update_action_item for each returned action_item_id — do not skip any task. ' +
      'Returns { action_item_id, created, title } — use action_item_id as the id parameter for update_action_item.',
    input_schema: {
      type: 'object',
      properties: {
        task_text: {
          type: 'string',
          description: 'The verbatim text of the task from the pasted note selection (used to look up an existing action item by fuzzy title match)',
        },
        source_note_id: {
          type: 'string',
          description: 'The ID of the note the task came from (from the pasted note selection metadata)',
        },
      },
      required: ['task_text', 'source_note_id'],
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

function executeTool(
  toolName: string,
  input: Record<string, unknown>,
  slugToTypeId?: Map<string, string>,
  slugToTypeName?: Map<string, string>,
): ExecutedAction {
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
        project_entity_id?: string
        contexts?: string[]
        energy_level?: 'low' | 'medium' | 'high'
        is_waiting_for?: boolean
        parent_id?: string
      }
      const id = randomUUID()
      db.prepare(
        `INSERT INTO action_items
           (id, title, source_note_id, assigned_entity_id, due_date,
            project_entity_id, contexts, energy_level, is_waiting_for, parent_id,
            extraction_type, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 1.0)`,
      ).run(
        id,
        inp.title,
        inp.source_note_id ?? null,
        inp.assigned_entity_id ?? null,
        inp.due_date ?? null,
        inp.project_entity_id ?? null,
        JSON.stringify(inp.contexts ?? []),
        inp.energy_level ?? null,
        inp.is_waiting_for ? 1 : 0,
        inp.parent_id ?? null,
      )
      const row = db
        .prepare(
          `SELECT ai.id, ai.title, ai.status, ai.due_date,
                  e.name AS assigned_entity_name, pe.name AS project_name
           FROM action_items ai
           LEFT JOIN entities e ON e.id = ai.assigned_entity_id
           LEFT JOIN entities pe ON pe.id = ai.project_entity_id
           WHERE ai.id = ?`,
        )
        .get(id) as { id: string; title: string; status: string; due_date: string | null; assigned_entity_name: string | null; project_name: string | null }
      return { type: 'created_action', payload: row }
    }

    case 'update_action_item': {
      const { id, ...updates } = input as {
        id: string
        title?: string
        status?: string
        due_date?: string | null
        assigned_entity_id?: string | null
        project_entity_id?: string | null
        contexts?: string[]
        energy_level?: 'low' | 'medium' | 'high' | null
        is_waiting_for?: boolean
        parent_id?: string | null
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
      if ('project_entity_id' in updates) { sets.push('project_entity_id = ?'); params.push(updates.project_entity_id ?? null) }
      if ('contexts' in updates) { sets.push('contexts = ?'); params.push(JSON.stringify(updates.contexts ?? [])) }
      if ('energy_level' in updates) { sets.push('energy_level = ?'); params.push(updates.energy_level ?? null) }
      if ('is_waiting_for' in updates) { sets.push('is_waiting_for = ?'); params.push(updates.is_waiting_for ? 1 : 0) }
      if ('parent_id' in updates) { sets.push('parent_id = ?'); params.push(updates.parent_id ?? null) }
      if (sets.length) {
        params.push(id)
        db.prepare(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`)
          .run(...(params as (string | number | null)[]))
      }
      const row = db
        .prepare(
          `SELECT ai.id, ai.title, ai.status, ai.due_date,
                  e.name AS assigned_entity_name, pe.name AS project_name
           FROM action_items ai
           LEFT JOIN entities e ON e.id = ai.assigned_entity_id
           LEFT JOIN entities pe ON pe.id = ai.project_entity_id
           WHERE ai.id = ?`,
        )
        .get(id) as { id: string; title: string; status: string; due_date: string | null; assigned_entity_name: string | null; project_name: string | null } | undefined
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

    case 'ensure_action_item_for_task': {
      const { task_text, source_note_id } = input as { task_text: string; source_note_id: string }
      const existing = db
        .prepare(
          `SELECT id, title FROM action_items
           WHERE source_note_id = ? AND title LIKE '%'||?||'%' AND status != 'cancelled'
           LIMIT 1`,
        )
        .get(source_note_id, task_text) as { id: string; title: string } | undefined
      if (existing) {
        return {
          type: 'ensured_action_found',
          payload: { id: existing.id, action_item_id: existing.id, title: existing.title, created: false },
        }
      }
      // No existing match — create a new action item linked to the note
      const newId = randomUUID()
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO action_items
           (id, title, source_note_id, extraction_type, confidence, created_at, updated_at)
         VALUES (?, ?, ?, 'manual', 1.0, ?, ?)`,
      ).run(newId, task_text, source_note_id, now, now)
      return {
        type: 'ensured_action_created',
        payload: { id: newId, action_item_id: newId, title: task_text, created: true },
      }
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

    default: {
      // Dynamic entity creation tools: create_<slug>
      if (toolName.startsWith('create_') && slugToTypeId && slugToTypeName) {
        const slug = toolName.slice('create_'.length)
        const typeId = slugToTypeId.get(slug)
        const typeName = slugToTypeName.get(slug)
        if (!typeId || !typeName) throw new Error(`Unknown tool: ${toolName}`)

        const { name, ...fieldValues } = input as { name: string; [key: string]: unknown }
        const id = randomUUID()
        const now = new Date().toISOString()

        // Serialise field values: arrays go in as JSON strings, everything else as plain string
        const fieldsObj: Record<string, string> = {}
        for (const [key, value] of Object.entries(fieldValues)) {
          if (value === undefined || value === null) continue
          fieldsObj[key] = Array.isArray(value) ? JSON.stringify(value) : String(value)
        }

        db.prepare(
          `INSERT INTO entities (id, name, type_id, fields, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, name, typeId, JSON.stringify(fieldsObj), now, now)

        return { type: 'created_entity', payload: { id, name, type_name: typeName } }
      }

      // Dynamic entity edit tools: edit_<slug>
      if (toolName.startsWith('edit_') && slugToTypeId && slugToTypeName) {
        const slug = toolName.slice('edit_'.length)
        const typeId = slugToTypeId.get(slug)
        const typeName = slugToTypeName.get(slug)
        if (!typeId || !typeName) throw new Error(`Unknown tool: ${toolName}`)

        const { id, name, ...fieldValues } = input as { id: string; name?: string; [key: string]: unknown }

        // Load existing entity
        const existing = db
          .prepare('SELECT id, name, fields FROM entities WHERE id = ? AND type_id = ? AND trashed_at IS NULL')
          .get(id, typeId) as { id: string; name: string; fields: string } | undefined
        if (!existing) throw new Error(`${typeName} entity with id ${id} not found`)

        // Merge incoming field updates onto the existing fields JSON
        let existingFields: Record<string, string> = {}
        try {
          existingFields = JSON.parse(existing.fields) as Record<string, string>
        } catch { /* start fresh if stored value is malformed */ }

        for (const [key, value] of Object.entries(fieldValues)) {
          if (value === undefined || value === null) {
            delete existingFields[key]
          } else {
            existingFields[key] = Array.isArray(value) ? JSON.stringify(value) : String(value)
          }
        }

        const updatedName = name !== undefined ? name : existing.name
        const now = new Date().toISOString()

        db.prepare(
          `UPDATE entities SET name = ?, fields = ?, updated_at = ? WHERE id = ?`,
        ).run(updatedName, JSON.stringify(existingFields), now, id)

        return { type: 'updated_entity', payload: { id, name: updatedName, type_name: typeName } }
      }

      throw new Error(`Unknown tool: ${toolName}`)
    }
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
  if (item.project_name) {
    const ref = item.project_entity_id ? `{{entity:${item.project_entity_id}:${item.project_name}}}` : item.project_name
    line += ` [project: ${ref}]`
  }
  if (item.due_date) line += ` (due: ${item.due_date})`
  if (item.assigned_entity_name) {
    const ref = item.assigned_entity_id ? `{{entity:${item.assigned_entity_id}:${item.assigned_entity_name}}}` : item.assigned_entity_name
    line += ` → ${ref}`
  }
  if (item.source_note_title) line += ` (from: "${item.source_note_title}")`
  return line
}

/**
 * Extract search keywords from a question using Claude Haiku, with optional
 * conversation history so follow-up questions ("and when was that?") resolve
 * to the right topic ("Bifrost", "meeting") based on prior context.
 *
 * Also classifies whether the question needs real-time web information:
 * needsWebSearch = true for current events, latest releases, prices, weather, etc.
 * needsWebSearch = false for personal notes, meetings, tasks, history.
 *
 * Returns base-form keywords in any language without stop-word lists.
 * Falls back to splitting the raw query on whitespace if the API call fails.
 */
export async function extractSearchKeywords(
  question: string,
  recentHistory?: { role: 'user' | 'assistant'; content: string }[],
): Promise<{ keywords: string[]; needsWebSearch: boolean }> {
  const fallbackKeywords = question.split(/\s+/).filter((w) => w.length >= 3)
  const db = getDatabase()

  // Build a short conversation snippet (last 4 messages) so the model can resolve
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
    return await callWithFallback('query_expand', db, async (model) => {
      const result = await model.adapter.chat(
        {
          model: model.modelId,
          maxTokens: 80,
          messages: [
            {
              role: 'user',
              content:
                `${contextBlock}` +
                'Based on the conversation above and the latest question, do two things:\n' +
                '1. Extract 3-6 search keywords in their base/dictionary form, space-separated, no punctuation.\n' +
                '   Preserve proper nouns exactly. Always respond in the same language as the question.\n' +
                '2. Decide if the question needs REAL-TIME web information (current events, latest software releases,\n' +
                '   live prices, today\'s weather, breaking news, etc.) that cannot come from a personal note archive.\n' +
                '   WEB_SEARCH: YES only for real-time/current info. WEB_SEARCH: NO for personal notes, meetings,\n' +
                '   tasks, people, projects, or any historical/archived information.\n\n' +
                'Output format (exactly two lines, nothing else):\n' +
                '<keywords on this line>\n' +
                'WEB_SEARCH: YES|NO\n\n' +
                `Latest question: ${question}`,
            },
          ],
        },
        model.apiKey,
      )

      const lines = result.text.trim().split(/\n+/)
      const webSearchLine = lines.find((l) => l.trim().toUpperCase().startsWith('WEB_SEARCH:'))
      const needsWebSearch = webSearchLine?.trim().toUpperCase().includes('YES') ?? false

      const keywordLine = lines.find((l) => !l.trim().toUpperCase().startsWith('WEB_SEARCH:')) ?? ''
      const keywords = keywordLine
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[,;.]/g, ''))
        .filter((w) => w.length >= 2)

      return { keywords: keywords.length > 0 ? keywords : fallbackKeywords, needsWebSearch }
    })
  } catch {
    return { keywords: fallbackKeywords, needsWebSearch: false }
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
export async function expandQueryConcepts(query: string): Promise<string[]> {
  const db = getDatabase()
  try {
    return await callWithFallback('query_expand', db, async (model) => {
      const result = await model.adapter.chat(
        {
          model: model.modelId,
          maxTokens: 60,
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
        },
        model.apiKey,
      )

      return result.text
        .trim()
        .split(/\s+/)
        .map((w) => w.replace(/[,;.]/g, ''))
        .filter((w) => w.length >= 2)
    })
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
): Promise<T[]> {
  if (results.length <= 1) return results

  const db = getDatabase()
  const docList = results
    .map((r, i) => `[${i}] "${r.title}"\n${(r.excerpt ?? '').slice(0, 250)}`)
    .join('\n\n')

  try {
    return await callWithFallback('rerank', db, async (model) => {
      const result = await model.adapter.chat(
        {
          model: model.modelId,
          maxTokens: 80,
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
        },
        model.apiKey,
      )

      const match = result.text.match(/\[[\d,\s]+\]/)
      if (!match) return results

      const scores = JSON.parse(match[0]) as number[]
      if (!Array.isArray(scores) || scores.length !== results.length) return results

      return results
        .map((r, i) => ({ result: r, score: scores[i] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .map(({ result }) => result)
    })
  } catch {
    return results
  }
}

/**
 * Generate inline content for the note editor (insert or replace mode).
 * Returns a Markdown string to be parsed by parseMarkdownToTipTap().
 */
export async function generateInlineContent(
  userPrompt: string,
  noteBodyPlain: string,
  selectedText: string | undefined,
  contextNotes: { title: string; excerpt: string }[],
  richEntities?: RichEntityContext[],
  images?: { dataUrl: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }[],
  files?: AttachedFilePayload[],
  useWebSearch = false,
  overrideModelId?: string,
  noteSelections: NoteSelectionAttachment[] = [],
): Promise<string> {
  const db = getDatabase()

  const MAX_NOTE_CHARS = 3000
  const MAX_INLINE_CONTEXT_CHARS = 2000

  const truncatedBody =
    noteBodyPlain.length > MAX_NOTE_CHARS
      ? noteBodyPlain.slice(0, MAX_NOTE_CHARS) + '…'
      : noteBodyPlain

  let systemPrompt =
    `Today is ${getCurrentDateString()}.\n\n` +
    'You are an inline writing assistant embedded in a personal knowledge base editor. ' +
    'Your job is to produce content that fits seamlessly into the note at the cursor position. ' +
    'Always respond in the same language as the user prompt and note content. ' +
    'Return ONLY the content to insert — no preamble, no meta-commentary, no explanation. ' +
    'Use Markdown formatting: ## headings, - for bullets, - [ ] for tasks, **bold**, *italic*, `code`. ' +
    'GFM tables (| Col | Col |\\n| --- | --- |\\n| cell | cell |) for structured data.'

  if (truncatedBody) {
    systemPrompt +=
      `\n\nCurrent note content (for context — do not repeat it, just continue naturally):\n${truncatedBody}`
  }

  if (contextNotes.length > 0) {
    let ctxStr = contextNotes.map((n) => `Note: "${n.title}"\n${n.excerpt}`).join('\n\n---\n\n')
    if (ctxStr.length > MAX_INLINE_CONTEXT_CHARS) ctxStr = ctxStr.slice(0, MAX_INLINE_CONTEXT_CHARS) + '…'
    systemPrompt += `\n\nRelated notes from the knowledge base (use as reference if relevant):\n${ctxStr}`
  }

  if (richEntities && richEntities.length > 0) {
    const depthLabel = (d: number) =>
      d === 0 ? '← directly mentioned' : d === 1 ? '← via entity field' : '← via entity field (no further expansion)'
    const entityBlocks = richEntities
      .map((e) => {
        const header = `### {{entity:${e.id}:${e.name}}} (${e.type_name})  ${depthLabel(e.depth)}`
        const fieldLines = e.fields.map((f) => `  ${f.name}: ${f.value}`).join('\n')
        return fieldLines ? `${header}\n${fieldLines}` : header
      })
      .join('\n\n')
    systemPrompt +=
      '\n\n## Entity context\n' +
      'Entities mentioned in the prompt (use their data to inform the content).\n' +
      'When referencing any entity in your output, write {{entity:uuid:Name}} (use the exact uuid listed).\n' +
      'When referencing a note by title, write {{note:uuid:Name}} (if the uuid is known), or just [[Note Title]] if unknown.\n' +
      'These tokens will be rendered as interactive chips in the editor:\n\n' +
      entityBlocks
  }

  // Prepend pasted note selections as labelled context before the user instructions
  const selectionsPrefix = formatNoteSelectionsBlock(noteSelections)

  let userText: string
  if (selectedText) {
    userText =
      selectionsPrefix +
      `Selected text to rewrite:\n"""\n${selectedText}\n"""\n\n` +
      `Instructions: ${userPrompt}\n\n` +
      `Rewrite the selected text following the instructions. Return only the replacement content.`
  } else {
    userText =
      selectionsPrefix +
      `Instructions: ${userPrompt}\n\n` +
      `Generate the requested content to insert at the cursor position in the note.`
  }

  return callWithFallback('inline_ai', db, async (m) => {
    const anthropic = new Anthropic({ apiKey: m.apiKey })

    // When images or files are provided, build a multipart content array; otherwise use plain string
    const hasImages = images && images.length > 0
    const hasFiles = files && files.length > 0
    const userContent: Anthropic.MessageParam['content'] =
      hasImages || hasFiles
        ? [
            ...(hasImages ? images.map((img): Anthropic.ImageBlockParam => ({
              type: 'image',
              source: {
                type: 'base64',
                media_type: img.mimeType,
                data: img.dataUrl.includes(',') ? img.dataUrl.split(',')[1] : img.dataUrl,
              },
            })) : []),
            ...(hasFiles ? files.map((f) => ({
              type: 'document' as const,
              source: f.mimeType === 'application/pdf'
                ? { type: 'base64' as const, media_type: 'application/pdf' as const, data: f.content }
                : { type: 'text' as const, media_type: 'text/plain' as const, data: f.content },
            })) : []),
            { type: 'text' as const, text: userText },
          ]
        : userText

    // When web search is not needed, use a simple single-turn call (no tool loop overhead)
    if (!useWebSearch) {
      const response = await anthropic.messages.create({
        model: m.modelId,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userContent }],
      })
      const block = response.content[0]
      return block.type === 'text' ? block.text.trim() : ''
    }

    // Web search enabled: run a tool-use loop (max 5 iterations).
    // The web search tool is server-side — Anthropic executes it and embeds both
    // ServerToolUseBlock + WebSearchToolResultBlock in the assistant turn.
    // We just push the assistant turn and continue; no client-side tool execution needed.
    const loopMessages: Anthropic.MessageParam[] = [{ role: 'user', content: userContent }]
    const inlineTools: Anthropic.Messages.ToolUnion[] = [WEB_SEARCH_TOOL]
    const MAX_INLINE_ITERATIONS = 5

    for (let i = 0; i < MAX_INLINE_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: m.modelId,
        max_tokens: 1500,
        system: systemPrompt,
        tools: inlineTools,
        messages: loopMessages,
      })

      if (response.stop_reason !== 'tool_use') {
        const block = response.content.find((b) => b.type === 'text')
        return block?.type === 'text' ? block.text.trim() : ''
      }

      // Append assistant turn (contains server_tool_use + web_search_tool_result blocks)
      // No user tool_result turn needed — results are already embedded in the assistant content
      loopMessages.push({ role: 'assistant', content: response.content })
    }

    return ''
  }, overrideModelId)
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

/**
 * Format a list of NoteSelectionAttachments as a labelled context block for
 * injection into the last user message sent to the model.
 * Mirrors the renderer-side `formatNoteSelectionsForPrompt` utility (kept in
 * the main process to avoid cross-process imports).
 */
function countSelectedTaskLines(selectedText: string): number {
  return selectedText.split('\n').filter((l) => /^-\s+\[.\]/.test(l.trim())).length
}

function formatNoteSelectionsBlock(selections: NoteSelectionAttachment[]): string {
  if (selections.length === 0) return ''
  const blocks = selections
    .map((s) => {
      const taskCount = countSelectedTaskLines(s.selectedText)
      const taskHint = taskCount > 0 ? `, ${taskCount} task${taskCount !== 1 ? 's' : ''} selected` : ''
      const header = `--- Note Selection: "${s.noteTitle}" (note_id: ${s.noteId}, blocks ${s.blockStart}–${s.blockEnd}${taskHint}) ---`
      return `${header}\n${s.selectedText}\n---`
    })
    .join('\n\n')
  return `<note_selections>\n${blocks}\n</note_selections>\n\n`
}

export async function sendChatMessage(
  messages: { role: 'user' | 'assistant'; content: string }[],
  contextNotes: { id: string; title: string; excerpt: string }[],
  calendarEvents: CalendarEventContext[] = [],
  actionItems: ActionItemContext[] = [],
  images?: { dataUrl: string; mimeType: string }[],
  files?: AttachedFilePayload[],
  entityContext: EntityContext[] = [],
  pinnedNotes: EntityLinkedNote[] = [],
  richEntities: RichEntityContext[] = [],
  entityLinkedNotes: EntityLinkedNote[] = [],
  useWebSearch = false,
  overrideModelId?: string,
  noteSelections: NoteSelectionAttachment[] = [],
): Promise<{ content: string; actions: ExecutedAction[]; entityRefs: { id: string; name: string }[]; fallbackWarning?: string }> {
  const db = getDatabase()
  let fallbackWarning: string | undefined

  const { tools: entityTools, slugToTypeId, slugToTypeName } = buildEntityTools(db)

  let systemPrompt =
    'You are Wizz, an AI assistant built into an engineering manager\'s personal knowledge base. ' +
    'You help the user find information from their notes, understand patterns across meetings, ' +
    'and think through problems using their accumulated context.\n\n' +
    `Today is ${getCurrentDateString()}.\n\n` +
    'Always reply in the same language the user writes in.\n\n' +
    'Be concise and actionable. When you don\'t have relevant context, say so rather than guessing.\n\n' +
    'You have tools available to create, update, and delete calendar events and action items, create notes, ' +
    'and create or edit entities (people, teams, projects, and other custom types). ' +
    'Use them when the user asks you to make a change (schedule, add, create, write, draft, generate, mark, update, move, cancel, delete, etc.). ' +
    'For creates and updates: execute immediately without asking. ' +
    'When editing an entity, resolve its ID from the entity context provided, then call the edit_<type> tool — only send the fields you want to change. ' +
    'For deletes: describe what you are about to delete and ask the user to confirm before calling the delete tool. ' +
    'When creating a note, generate rich, well-structured Markdown content — use headings, bullet lists, task checkboxes, and GFM tables (| Col | Col |\\n| --- | --- |\\n| val | val |) as appropriate.\n\n' +
    'When a <note_selections> block is present and the user refers to "these tasks", "them", or similar:\n' +
    '  1. The scope is STRICTLY LIMITED to the task lines listed inside that block — do NOT act on other\n' +
    '     action items from the same note that appear in the action items list but were not in the selection.\n' +
    '  2. Process EVERY task line from the selection, one by one, without skipping any.\n' +
    '  3. For each task: first check whether it already appears in the action items context with an [id:...] —\n' +
    '     if yes, use that ID directly in update_action_item; if not, call ensure_action_item_for_task first.\n' +
    '  4. Do not stop after the first task — keep calling tools until every selected task has been updated.'

  if (pinnedNotes.length > 0) {
    const pinnedStr = pinnedNotes
      .map((n) => `### {{note:${n.id}:${n.title}}}\n${n.excerpt}`)
      .join('\n\n---\n\n')
    systemPrompt +=
      '\n\nThe user has explicitly attached the following notes to this conversation. ' +
      'Treat them as primary source material and prioritise them over search results:\n\n' +
      pinnedStr
  }

  if (contextNotes.length > 0) {
    let contextStr = contextNotes
      .map((n) => `{{note:${n.id}:${n.title}}}\n${n.excerpt}`)
      .join('\n\n---\n\n')

    if (contextStr.length > MAX_CONTEXT_CHARS) {
      contextStr = contextStr.slice(0, MAX_CONTEXT_CHARS) + '…'
    }

    systemPrompt +=
      '\n\nHere are relevant notes from the user\'s knowledge base, ' +
      'including related notes retrieved via knowledge graph connections (wiki-links and shared entity mentions):\n\n' +
      contextStr +
      '\n\nWhen referencing an entity or note from the context, ALWAYS include its ID:\n' +
      '- Entity mention: {{entity:uuid:Name}}  (use the exact uuid provided)\n' +
      '- Note reference: {{note:uuid:Name}}  (use the exact uuid provided)\n' +
      '- Legacy note citation (only if no uuid was provided): [Note: "Title"]\n' +
      'These tokens render as clickable chips in the UI.'
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

  if (richEntities.length > 0) {
    const depthLabel = (d: number) =>
      d === 0 ? '← directly mentioned' : d === 1 ? '← via entity field' : '← via entity field (no further expansion)'
    const entityBlocks = richEntities
      .map((e) => {
        const header = `### {{entity:${e.id}:${e.name}}} (${e.type_name})  ${depthLabel(e.depth)}`
        const fieldLines = e.fields.map((f) => `  ${f.name}: ${f.value}`).join('\n')
        return fieldLines ? `${header}\n${fieldLines}` : header
      })
      .join('\n\n')
    systemPrompt +=
      '\n\n## Entity context\n' +
      'Entities mentioned or referenced in this conversation.\n' +
      'When mentioning any entity in your response, write {{entity:uuid:Name}} (use the exact uuid listed).\n' +
      'Use the uuid when assigning tasks or referencing entities (e.g. only assign to Person-type entities):\n\n' +
      entityBlocks
  } else if (entityContext.length > 0) {
    const entityLines = entityContext
      .map((e) => `- {{entity:${e.id}:${e.name}}} (type: ${e.type_name})`)
      .join('\n')
    systemPrompt +=
      '\n\nEntities mentioned in this conversation. When mentioning any entity in your response, ' +
      'write {{entity:uuid:Name}} (use the exact uuid listed). ' +
      'Always confirm the entity type is appropriate for the operation ' +
      '(e.g. only assign tasks to Person-type entities):\n' +
      entityLines
  }

  if (entityLinkedNotes.length > 0) {
    const noteBlocks = entityLinkedNotes
      .map((n) => `### {{note:${n.id}:${n.title}}}\n${n.excerpt}`)
      .join('\n\n---\n\n')
    systemPrompt +=
      '\n\n## Notes linked via entity fields\n' +
      'These notes were found through entity field references:\n\n' +
      noteBlocks
  }

  // Pre-compute lastUserIndex (no model needed)
  const lastUserIndex = [...messages].map((msg) => msg.role).lastIndexOf('user')

  const chatResult = await callWithFallback('chat', db, async (m) => {
    const anthropic = new Anthropic({ apiKey: m.apiKey })

    // Build a mutable message list for the tool loop.
    // The loop may append assistant tool-use blocks and user tool-result blocks.
    // If images, files, or note selections are provided, attach them to the last
    // user message as content blocks / prepended text.
    const noteSelectionsPrefix = formatNoteSelectionsBlock(noteSelections)
    const loopMessages: Anthropic.MessageParam[] = messages.map((msg, i) => {
      const hasImages = images && images.length > 0
      const hasFiles = files && files.length > 0
      const hasSelections = noteSelectionsPrefix.length > 0
      if (i === lastUserIndex && (hasImages || hasFiles || hasSelections)) {
        // Prepend note selections to the user text so the model sees structured
        // context first, then the user's typed message.
        const userText = hasSelections
          ? noteSelectionsPrefix + (msg.content || '')
          : msg.content || '(see attached file)'
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
            { type: 'text' as const, text: userText },
          ],
        }
      }
      return { role: msg.role as 'user' | 'assistant', content: msg.content }
    })

    const allWizzTools: Anthropic.Tool[] = [...WIZZ_TOOLS, ...entityTools]
    const tools: Anthropic.Messages.ToolUnion[] = useWebSearch
      ? [...allWizzTools, WEB_SEARCH_TOOL]
      : allWizzTools

    const actions: ExecutedAction[] = []
    let finalText = ''

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await anthropic.messages.create({
        model: m.modelId,
        max_tokens: 4000,
        system: systemPrompt,
        tools,
        messages: loopMessages,
      })

      if (response.stop_reason !== 'tool_use') {
        // Terminal response — extract text content
        const textBlock = response.content.find((b) => b.type === 'text')
        finalText = textBlock?.type === 'text' ? textBlock.text.trim() : ''
        break
      }

      // Append assistant turn (may include text + tool_use + server_tool_use + web_search_tool_result blocks)
      loopMessages.push({ role: 'assistant', content: response.content })

      // Execute custom tool_use blocks; skip server_tool_use (web search handled server-side,
      // results are already embedded in the assistant content above)
      const toolResults: Anthropic.ToolResultBlockParam[] = []
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue

        let resultContent: string
        let isError = false
        try {
          const action = executeTool(block.name, block.input as Record<string, unknown>, slugToTypeId, slugToTypeName)
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

      // Only add a user turn when there are custom tool results to report.
      // For server-tool-only turns (web search), results are already in the assistant content —
      // the next loop iteration calls the API with the assistant turn as the last message,
      // letting Claude read the search results and produce the final answer.
      if (toolResults.length > 0) {
        loopMessages.push({ role: 'user', content: toolResults })
      }
    }

    // Scan final response for {{entity:uuid:Name}} tokens — ID is embedded directly.
    const entityRefsMap = new Map<string, { id: string; name: string }>()
    for (const match of finalText.matchAll(new RegExp(ENTITY_TOKEN_RE.source, 'g'))) {
      const id   = match[1]
      const name = match[2].trim()
      if (id && name && !entityRefsMap.has(id)) entityRefsMap.set(id, { id, name })
    }
    const entityRefs = Array.from(entityRefsMap.values())

    return { content: finalText, actions, entityRefs }
  }, overrideModelId, (from, to) => {
    fallbackWarning = `Used ${to} — primary model (${from}) unavailable`
  })
  return { ...chatResult, fallbackWarning }
}
