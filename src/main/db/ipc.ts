import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { getDatabase, isVecLoaded } from './index'
import { scheduleEmbedding } from '../embedding/pipeline'
import { setOpenAIKey, embedTexts } from '../embedding/embedder'
import { extractActionItems } from '../embedding/actionExtractor'
import { pushToRenderer } from '../push'
import { setChatAnthropicKey, sendChatMessage, extractSearchKeywords, expandQueryConcepts, reRankResults, generateInlineContent, CalendarEventContext, ActionItemContext, ExecutedAction, EntityContext, EntityLinkedNote, RichEntityContext, ResolvedField, type ChatModelId } from '../embedding/chat'
import { parseMarkdownToTipTap, ParseContext } from '../transcription/postProcessor'
import { ENTITY_TOKEN_RE } from '../utils/tokenFormat'
import { parseQuery } from '../entity-query/parser'
import { evalQuery } from '../entity-query/evaluator'
import {
  generateOccurrences,
  applyRecurrenceUpdate,
  applyRecurrenceDelete,
  getSeriesNotes,
  type UpdateScope,
  type DeleteScope,
} from '../calendar/recurrenceEngine'
import { getProvider } from '../calendar/sync/registry'
import { syncSourceNow } from '../calendar/sync/scheduler'
import type { CalendarSource } from '../calendar/sync/provider'
import { APPS_SCRIPT_SOURCE, APPS_SCRIPT_INSTRUCTIONS }                              from '../calendar/sync/providers/googleAppsScript'
import { RELAY_PERSONAL_SCRIPT_SOURCE, RELAY_CORP_SCRIPT_SOURCE, RELAY_INSTRUCTIONS } from '../calendar/sync/providers/googleAppsScriptRelay'
import { JSONBIN_SCRIPT_SOURCE, JSONBIN_INSTRUCTIONS }                                from '../calendar/sync/providers/jsonbin'

type NoteRow = {
  id: string
  title: string
  body: string
  body_plain: string
  source: string
  language: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

type NoteTemplateRow = {
  id: string
  name: string
  icon: string
  body: string
  entity_type_id: string | null
  auto_create_trigger: string | null
  created_at: string
}

type EntityTypeRow = {
  id: string
  name: string
  icon: string
  schema: string
  kanban_enabled: number
  kanban_status_field: string | null
  color: string | null
}

type EntityRow = {
  id: string
  name: string
  type_id: string
  fields: string
  created_at: string
  updated_at: string
  trashed_at: string | null
}

const BUILTIN_ENTITY_TYPE_IDS = new Set(['person', 'project', 'team', 'decision', 'okr'])

/**
 * Replace all mention nodes for a given entity ID with plain text nodes.
 * Returns the new doc and whether any replacements were made.
 */
function replaceMentionsWithText(
  doc: unknown,
  entityId: string,
  fallbackName: string
): { result: unknown; changed: boolean } {
  let changed = false
  function walk(node: unknown): unknown {
    if (!node || typeof node !== 'object') return node
    const n = node as Record<string, unknown>
    if (n['type'] === 'mention' && n['attrs'] && typeof n['attrs'] === 'object') {
      const attrs = n['attrs'] as Record<string, unknown>
      if (attrs['id'] === entityId) {
        changed = true
        return { type: 'text', text: (attrs['label'] as string) || fallbackName }
      }
      return node
    }
    if (Array.isArray(n['content'])) {
      return { ...n, content: n['content'].map(walk) }
    }
    return node
  }
  return { result: walk(doc), changed }
}

/**
 * Replace all noteLink nodes for a given note ID with plain text nodes.
 * Returns the new doc and whether any replacements were made.
 */
function replaceNoteLinksWithText(
  doc: unknown,
  noteId: string,
  fallbackTitle: string
): { result: unknown; changed: boolean } {
  let changed = false
  function walk(node: unknown): unknown {
    if (!node || typeof node !== 'object') return node
    const n = node as Record<string, unknown>
    if (n['type'] === 'noteLink' && n['attrs'] && typeof n['attrs'] === 'object') {
      const attrs = n['attrs'] as Record<string, unknown>
      if (attrs['id'] === noteId) {
        changed = true
        return { type: 'text', text: (attrs['label'] as string) || fallbackTitle }
      }
      return node
    }
    if (Array.isArray(n['content'])) {
      return { ...n, content: n['content'].map(walk) }
    }
    return node
  }
  return { result: walk(doc), changed }
}

/** Extract plain text from a TipTap JSON doc (for FTS body_plain). */
function extractDocPlainText(doc: unknown): string {
  const parts: string[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n['type'] === 'text' && typeof n['text'] === 'string') parts.push(n['text'])
    if (Array.isArray(n['content'])) for (const child of n['content']) walk(child)
  }
  walk(doc)
  return parts.join(' ')
}

/** Recursively walk TipTap JSON and collect note IDs from noteLink nodes. */
function extractNoteLinkIds(bodyJson: string): string[] {
  let doc: unknown
  try {
    doc = JSON.parse(bodyJson)
  } catch {
    return []
  }
  const ids: string[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n['type'] === 'noteLink' && n['attrs'] && typeof n['attrs'] === 'object') {
      const id = (n['attrs'] as Record<string, unknown>)['id']
      if (typeof id === 'string' && id) ids.push(id)
    }
    if (Array.isArray(n['content'])) {
      for (const child of n['content']) walk(child)
    }
  }
  walk(doc)
  return ids
}

/** Recursively walk TipTap JSON and collect entity IDs from mention nodes. */
function extractMentionIds(bodyJson: string): string[] {
  let doc: unknown
  try {
    doc = JSON.parse(bodyJson)
  } catch {
    return []
  }
  const ids: string[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n['type'] === 'mention' && n['attrs'] && typeof n['attrs'] === 'object') {
      const id = (n['attrs'] as Record<string, unknown>)['id']
      if (typeof id === 'string' && id) ids.push(id)
    }
    if (Array.isArray(n['content'])) {
      for (const child of n['content']) walk(child)
    }
  }
  walk(doc)
  return ids
}

/**
 * BFS traversal of the entity graph starting from directly-mentioned entity IDs.
 * Resolves field values (entity_ref, entity_ref_list, note_ref) up to depth 2
 * with a visited-set to prevent cycles. Returns rich entity context rows and
 * the set of note IDs encountered via note_ref fields.
 */
function buildRichEntityContext(
  db: ReturnType<typeof getDatabase>,
  mentionedEntityIds: string[],
): { richEntities: RichEntityContext[]; entityLinkedNoteIds: Set<string> } {
  const visited = new Set<string>()
  const queue: { id: string; depth: number }[] = mentionedEntityIds.map((id) => ({ id, depth: 0 }))
  const richEntities: RichEntityContext[] = []
  const entityLinkedNoteIds = new Set<string>()

  while (queue.length > 0) {
    const item = queue.shift()!
    if (visited.has(item.id)) continue
    visited.add(item.id)

    const row = db
      .prepare(
        `SELECT e.id, e.name, e.fields, et.name AS type_name, et.schema
         FROM entities e
         JOIN entity_types et ON et.id = e.type_id
         WHERE e.id = ? AND e.trashed_at IS NULL`,
      )
      .get(item.id) as { id: string; name: string; fields: string; type_name: string; schema: string } | undefined
    if (!row) continue

    let schemaDef: { fields?: { name: string; type: string; query?: string }[] } = {}
    let fieldValues: Record<string, string> = {}
    try { schemaDef = JSON.parse(row.schema || '{}') } catch { /* ignore */ }
    try { fieldValues = JSON.parse(row.fields || '{}') } catch { /* ignore */ }

    const resolvedFields: ResolvedField[] = []

    for (const fieldDef of schemaDef.fields ?? []) {
      if (fieldDef.type === 'computed') {
        // Execute the WQL query scoped to this entity and format results like entity_ref_list
        if (!fieldDef.query) continue
        try {
          const ast = parseQuery(fieldDef.query)
          const results = evalQuery(db, ast, item.id) as { id: string; name: string; type_id: string }[]
          if (!results.length) continue
          const parts = results.slice(0, 10).map((r) => {
            if (item.depth < 2 && !visited.has(r.id)) queue.push({ id: r.id, depth: item.depth + 1 })
            return `@${r.name} [id:${r.id}]`
          })
          resolvedFields.push({ name: fieldDef.name, value: parts.join(', ') })
        } catch {
          // Skip fields with invalid or erroring WQL
        }
        continue
      }
      const value = fieldValues[fieldDef.name]
      if (!value) continue

      if (fieldDef.type === 'entity_ref') {
        const ref = db.prepare('SELECT id, name FROM entities WHERE id = ? AND trashed_at IS NULL').get(value) as { id: string; name: string } | undefined
        if (ref) {
          resolvedFields.push({ name: fieldDef.name, value: `@${ref.name} [id:${ref.id}]` })
          if (item.depth < 2 && !visited.has(ref.id)) queue.push({ id: ref.id, depth: item.depth + 1 })
        } else {
          resolvedFields.push({ name: fieldDef.name, value: '(deleted)' })
        }
      } else if (fieldDef.type === 'entity_ref_list') {
        let ids: string[] = []
        try { const p = JSON.parse(value); ids = Array.isArray(p) ? p : [value] } catch { ids = value.split(',').map((s) => s.trim()).filter(Boolean) }
        const parts: string[] = []
        for (const refId of ids) {
          const ref = db.prepare('SELECT id, name FROM entities WHERE id = ? AND trashed_at IS NULL').get(refId) as { id: string; name: string } | undefined
          if (ref) {
            parts.push(`@${ref.name} [id:${ref.id}]`)
            if (item.depth < 2 && !visited.has(ref.id)) queue.push({ id: ref.id, depth: item.depth + 1 })
          } else {
            parts.push('(deleted)')
          }
        }
        if (parts.length) resolvedFields.push({ name: fieldDef.name, value: parts.join(', ') })
      } else if (fieldDef.type === 'note_ref') {
        const note = db.prepare('SELECT id, title FROM notes WHERE id = ? AND archived_at IS NULL').get(value) as { id: string; title: string } | undefined
        if (note) {
          resolvedFields.push({ name: fieldDef.name, value: `[[${note.title}]] [id:${note.id}]` })
          entityLinkedNoteIds.add(note.id)
        } else {
          resolvedFields.push({ name: fieldDef.name, value: '(archived)' })
        }
      } else if (fieldDef.type === 'text_list') {
        let items: string[] = []
        try { const p = JSON.parse(value); items = Array.isArray(p) ? p : [value] } catch { items = [value] }
        resolvedFields.push({ name: fieldDef.name, value: items.join(', ') })
      } else {
        resolvedFields.push({ name: fieldDef.name, value })
      }
    }

    richEntities.push({ id: row.id, name: row.name, type_name: row.type_name, depth: item.depth, fields: resolvedFields })
  }

  return { richEntities, entityLinkedNoteIds }
}

export function registerDbIpcHandlers(): void {
  /**
   * db:status — returns SQLite version and the list of tables.
   * Useful for health checks and debugging from the renderer.
   */
  ipcMain.handle('db:status', () => {
    const db = getDatabase()
    const { version } = db
      .prepare('SELECT sqlite_version() AS version')
      .get() as { version: string }
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[]
    ).map((r) => r.name)
    return { ok: true, sqliteVersion: version, tables }
  })

  /** notes:create — inserts a new note and returns the full row. Accepts optional title, body, and template_id. */
  ipcMain.handle('notes:create', (_event, opts?: { title?: string; body?: string; template_id?: string }) => {
    const db = getDatabase()
    const id = randomUUID()
    const title = opts?.title ?? 'Untitled'
    const body = opts?.body ?? '{}'
    const template_id = opts?.template_id ?? null
    db.prepare(
      `INSERT INTO notes (id, title, body, body_plain, template_id) VALUES (?, ?, ?, ?, ?)`
    ).run(id, title, body, '', template_id)
    return db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow
  })

  /** notes:get — returns a single note by id, or null if not found. */
  ipcMain.handle('notes:get', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    return (db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow) ?? null
  })

  /** notes:list — returns all non-archived notes sorted by updated_at DESC. */
  ipcMain.handle('notes:list', () => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT id, title, updated_at, created_at FROM notes
         WHERE archived_at IS NULL ORDER BY updated_at DESC`
      )
      .all()
  })

  /** notes:delete — soft-deletes a note by setting archived_at, and unlinks it from any calendar events. */
  ipcMain.handle('notes:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    db.prepare(
      `UPDATE notes SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(id)
    // Unlink this note from any calendar event that references it as meeting notes
    db.prepare(`UPDATE calendar_events SET linked_note_id = NULL WHERE linked_note_id = ?`).run(id)
    return { ok: true }
  })

  /** notes:restore — clears archived_at, bringing a note back from trash. */
  ipcMain.handle('notes:restore', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    db.prepare(`UPDATE notes SET archived_at = NULL WHERE id = ?`).run(id)
    return { ok: true }
  })

  /**
   * notes:delete-forever — hard-deletes a note permanently.
   * Before deleting, replaces all [[noteLink]] chips in other notes with plain text of the note's title.
   */
  ipcMain.handle('notes:delete-forever', (_event, { id }: { id: string }) => {
    const db = getDatabase()

    const noteRow = db.prepare('SELECT title FROM notes WHERE id = ?').get(id) as { title: string } | undefined
    const noteTitle = noteRow?.title ?? ''

    // Replace noteLink nodes with plain text in every note that links to this note
    const linkingNotes = db
      .prepare(
        `SELECT DISTINCT source_note_id FROM note_relations
         WHERE target_note_id = ? AND relation_type = 'references'`
      )
      .all(id) as { source_note_id: string }[]

    for (const { source_note_id } of linkingNotes) {
      const sourceRow = db.prepare('SELECT body FROM notes WHERE id = ?').get(source_note_id) as { body: string } | undefined
      if (!sourceRow) continue
      let doc: unknown
      try { doc = JSON.parse(sourceRow.body) } catch { continue }
      const { result, changed } = replaceNoteLinksWithText(doc, id, noteTitle)
      if (changed) {
        const newBody = JSON.stringify(result)
        const newPlain = extractDocPlainText(result)
        db.prepare(
          `UPDATE notes SET body = ?, body_plain = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
        ).run(newBody, newPlain, source_note_id)
      }
    }

    // Clean up note_relations involving this note, then hard-delete
    db.prepare(`DELETE FROM note_relations WHERE source_note_id = ? OR target_note_id = ?`).run(id, id)
    db.prepare(`DELETE FROM notes WHERE id = ?`).run(id)
    return { ok: true }
  })

  /**
   * notes:search — searches non-archived notes by title.
   * Used by the [[ note-link suggestion in the note editor.
   */
  ipcMain.handle('notes:search', (_event, { query }: { query: string }) => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT id, title FROM notes
         WHERE title LIKE ? COLLATE NOCASE AND archived_at IS NULL
         ORDER BY updated_at DESC LIMIT 20`
      )
      .all(`%${query}%`)
  })

  /**
   * notes:get-archived-status — batch check which note IDs are archived.
   * Input: { ids: string[] }
   * Returns: Record<string, boolean> mapping id → is_archived
   */
  ipcMain.handle('notes:get-archived-status', (_event, { ids }: { ids: string[] }) => {
    if (!ids.length) return {}
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT id, archived_at FROM notes WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; archived_at: string | null }[]
    const result: Record<string, boolean> = {}
    for (const row of rows) {
      result[row.id] = row.archived_at !== null
    }
    return result
  })

  /**
   * notes:get-link-count — returns how many distinct notes link to a given note.
   * Used to show a confirmation before archiving/trashing.
   */
  ipcMain.handle('notes:get-link-count', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    const { count } = db
      .prepare(
        `SELECT COUNT(DISTINCT source_note_id) AS count
         FROM note_relations WHERE target_note_id = ? AND relation_type = 'references'`
      )
      .get(id) as { count: number }
    return { count }
  })

  /**
   * notes:get-backlinks — returns all non-archived notes that [[link]] to a given note,
   * ordered by most recently updated. Used by NoteEditor to show the backlinks footer.
   */
  ipcMain.handle('notes:get-backlinks', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT n.id, n.title
         FROM note_relations nr
         JOIN notes n ON n.id = nr.source_note_id
         WHERE nr.target_note_id = ? AND nr.relation_type = 'references'
           AND n.archived_at IS NULL
         ORDER BY n.updated_at DESC`
      )
      .all(id) as { id: string; title: string }[]
  })

  /**
   * notes:update — updates title, body, body_plain, and updated_at for a note.
   * Also syncs entity_mentions from the body JSON.
   * Called by the renderer's auto-save debounce.
   */
  ipcMain.handle(
    'notes:update',
    (
      _event,
      {
        id,
        title,
        body,
        body_plain,
      }: { id: string; title: string; body: string; body_plain: string }
    ) => {
      const db = getDatabase()
      db.prepare(
        `UPDATE notes
         SET title = ?, body = ?, body_plain = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(title, body, body_plain, id)

      // Sync entity_mentions: rebuild manual mentions from current body.
      // auto_detected mentions are managed separately by the NER pipeline step.
      const mentionIds = extractMentionIds(body)
      db.prepare(`DELETE FROM entity_mentions WHERE note_id = ? AND mention_type = 'manual'`).run(
        id
      )
      const insertMention = db.prepare(
        `INSERT INTO entity_mentions (note_id, entity_id, mention_type, confidence) VALUES (?, ?, 'manual', 1.0)`
      )
      for (const eid of mentionIds) {
        insertMention.run(id, eid)
      }

      // Sync note_relations: rebuild manual [[note-link]] references
      const noteLinkIds = extractNoteLinkIds(body)
      db.prepare(
        `DELETE FROM note_relations WHERE source_note_id = ? AND relation_type = 'references'`
      ).run(id)
      const insertRelation = db.prepare(
        `INSERT INTO note_relations (source_note_id, target_note_id, relation_type, strength)
         VALUES (?, ?, 'references', 1.0)`
      )
      for (const targetId of noteLinkIds) {
        insertRelation.run(id, targetId)
      }

      // Fire-and-forget: generate embeddings in the background (never blocks the save)
      scheduleEmbedding(id)

      return { ok: true }
    }
  )

  /**
   * notes:get-auto-detections — returns NER-detected entities for a note.
   * Used by the editor to render decoration hints for untagged entity mentions.
   */
  ipcMain.handle('notes:get-auto-detections', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT
           em.entity_id,
           e.name        AS entity_name,
           e.type_id,
           et.name       AS type_name,
           et.icon       AS type_icon,
           et.color      AS type_color,
           em.confidence
         FROM entity_mentions em
         JOIN entities    e  ON em.entity_id = e.id
         JOIN entity_types et ON e.type_id    = et.id
         WHERE em.note_id        = ?
           AND em.mention_type   = 'auto_detected'
           AND e.trashed_at IS NULL`
      )
      .all(id)
  })

  // ─── Entity Types ───────────────────────────────────────────────────────────

  /** entity-types:list — returns all entity types sorted by name. */
  ipcMain.handle('entity-types:list', () => {
    const db = getDatabase()
    return db
      .prepare(`SELECT * FROM entity_types ORDER BY name COLLATE NOCASE`)
      .all() as EntityTypeRow[]
  })

  /**
   * entity-types:create — creates a new custom entity type.
   * Built-in IDs (person/project/team/decision/okr) are blocked.
   */
  ipcMain.handle(
    'entity-types:create',
    (
      _event,
      {
        name,
        icon,
        color,
        schema,
      }: { name: string; icon: string; color: string; schema: string }
    ) => {
      const db = getDatabase()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO entity_types (id, name, icon, color, schema) VALUES (?, ?, ?, ?, ?)`
      ).run(id, name, icon, color, schema)
      return db.prepare('SELECT * FROM entity_types WHERE id = ?').get(id) as EntityTypeRow
    }
  )

  /**
   * entity-types:update — updates name, icon, color, and schema for any entity type.
   * Built-in types can be edited (fields/icon/color/name) but not deleted.
   */
  ipcMain.handle(
    'entity-types:update',
    (
      _event,
      {
        id,
        name,
        icon,
        color,
        schema,
      }: { id: string; name: string; icon: string; color: string; schema: string }
    ) => {
      const db = getDatabase()
      db.prepare(
        `UPDATE entity_types SET name = ?, icon = ?, color = ?, schema = ? WHERE id = ?`
      ).run(name, icon, color, schema, id)
      return db.prepare('SELECT * FROM entity_types WHERE id = ?').get(id) as EntityTypeRow
    }
  )

  /**
   * entity-types:delete — deletes a custom entity type.
   * Built-in types cannot be deleted.
   */
  ipcMain.handle('entity-types:delete', (_event, { id }: { id: string }) => {
    if (BUILTIN_ENTITY_TYPE_IDS.has(id)) {
      return { ok: false, error: 'Cannot delete built-in entity types' }
    }
    const db = getDatabase()
    db.prepare(`DELETE FROM entity_types WHERE id = ?`).run(id)
    return { ok: true }
  })

  /**
   * entity-types:schema-for-autocomplete — returns all entity types with their
   * field names, used by QueryFieldEditor to power WQL autocomplete suggestions.
   */
  ipcMain.handle('entity-types:schema-for-autocomplete', () => {
    const db = getDatabase()
    const rows = db.prepare(`SELECT id, name, schema FROM entity_types`).all() as {
      id: string
      name: string
      schema: string
    }[]
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      fields: ((JSON.parse(row.schema)?.fields ?? []) as { name: string }[]).map(
        (f) => f.name,
      ),
    }))
  })

  // ─── Entities ────────────────────────────────────────────────────────────────

  /**
   * entities:search — searches non-trashed entities by name.
   * Used by the @mention suggestion in the note editor and attendee entity search.
   * Optional type_id filter restricts results to a specific entity type.
   */
  ipcMain.handle('entities:search', (_event, { query, type_id }: { query: string; type_id?: string }) => {
    const db = getDatabase()
    const params: unknown[] = [`%${query}%`]
    let sql = `SELECT e.id, e.name, e.type_id, et.name AS type_name, et.icon AS type_icon
               FROM entities e
               JOIN entity_types et ON e.type_id = et.id
               WHERE e.name LIKE ? COLLATE NOCASE
                 AND e.trashed_at IS NULL`
    if (type_id) {
      sql += ` AND e.type_id = ?`
      params.push(type_id)
    }
    sql += ` ORDER BY e.name COLLATE NOCASE LIMIT 20`
    return db.prepare(sql).all(...params)
  })

  /** entities:list — returns all non-trashed entities of a given type with optional sort. */
  ipcMain.handle(
    'entities:list',
    (
      _event,
      {
        type_id,
        sortField,
        sortDir,
        includeFields,
      }: {
        type_id: string
        sortField?: string
        sortDir?: 'asc' | 'desc'
        includeFields?: boolean
      }
    ) => {
      const db = getDatabase()
      const BUILTIN_COLS: Record<string, string> = {
        name: 'name COLLATE NOCASE',
        created_at: 'created_at',
        updated_at: 'updated_at',
      }
      const field = sortField ?? 'name'
      const dir = sortDir === 'desc' ? 'DESC' : 'ASC'
      const orderExpr =
        BUILTIN_COLS[field] ??
        `JSON_EXTRACT(fields, '$.${field.replace(/[^a-zA-Z0-9_]/g, '')}') COLLATE NOCASE`
      const cols = includeFields
        ? 'id, name, type_id, updated_at, created_at, fields'
        : 'id, name, type_id, updated_at, created_at'
      return db
        .prepare(
          `SELECT ${cols} FROM entities WHERE type_id = ? AND trashed_at IS NULL ORDER BY ${orderExpr} ${dir}`
        )
        .all(type_id)
    }
  )

  /** entities:create — creates a new entity with a given type and name. */
  ipcMain.handle(
    'entities:create',
    (_event, { type_id, name }: { type_id: string; name: string }) => {
      const db = getDatabase()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO entities (id, name, type_id, fields) VALUES (?, ?, ?, ?)`
      ).run(id, name, type_id, '{}')
      return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow
    }
  )

  /**
   * entities:get — returns a single entity plus its parsed type schema.
   * Returns null if not found.
   */
  ipcMain.handle('entities:get', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    const entity = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined
    if (!entity) return null
    const entityType = db
      .prepare('SELECT * FROM entity_types WHERE id = ?')
      .get(entity.type_id) as EntityTypeRow
    return { entity, entityType }
  })

  /** entities:update — updates name and fields JSON for an entity. */
  ipcMain.handle(
    'entities:update',
    (_event, { id, name, fields }: { id: string; name: string; fields: Record<string, unknown> }) => {
      const db = getDatabase()
      db.prepare(
        `UPDATE entities
         SET name = ?, fields = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`
      ).run(name, JSON.stringify(fields), id)
      return { ok: true }
    }
  )

  /**
   * entities:delete — soft-deletes (trashes) an entity.
   * Returns { ok, mentionNoteCount } so the caller can confirm if there are mentions.
   */
  ipcMain.handle('entities:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    const { count } = db
      .prepare(`SELECT COUNT(DISTINCT note_id) AS count FROM entity_mentions WHERE entity_id = ?`)
      .get(id) as { count: number }
    db.prepare(
      `UPDATE entities SET trashed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(id)
    return { ok: true, mentionNoteCount: count }
  })

  /** entities:restore — clears trashed_at, bringing an entity back from trash. */
  ipcMain.handle('entities:restore', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    db.prepare(`UPDATE entities SET trashed_at = NULL WHERE id = ?`).run(id)
    return { ok: true }
  })

  /**
   * entities:delete-forever — hard-deletes an entity permanently.
   * Before deleting, replaces all @mention chips in notes with plain text of the entity name.
   */
  ipcMain.handle('entities:delete-forever', (_event, { id }: { id: string }) => {
    const db = getDatabase()

    const entityRow = db.prepare('SELECT name FROM entities WHERE id = ?').get(id) as { name: string } | undefined
    const entityName = entityRow?.name ?? ''

    // Replace mention nodes with plain text in every note that mentions this entity
    const mentioningNotes = db
      .prepare(`SELECT DISTINCT note_id FROM entity_mentions WHERE entity_id = ?`)
      .all(id) as { note_id: string }[]

    for (const { note_id } of mentioningNotes) {
      const noteRow = db.prepare('SELECT body FROM notes WHERE id = ?').get(note_id) as { body: string } | undefined
      if (!noteRow) continue
      let doc: unknown
      try { doc = JSON.parse(noteRow.body) } catch { continue }
      const { result, changed } = replaceMentionsWithText(doc, id, entityName)
      if (changed) {
        const newBody = JSON.stringify(result)
        const newPlain = extractDocPlainText(result)
        db.prepare(
          `UPDATE notes SET body = ?, body_plain = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
        ).run(newBody, newPlain, note_id)
      }
    }

    db.prepare(`DELETE FROM entities WHERE id = ?`).run(id)
    return { ok: true }
  })

  /**
   * entities:get-mention-count — returns how many distinct notes mention an entity.
   * Used to show a confirmation before trashing.
   */
  ipcMain.handle('entities:get-mention-count', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    const { count } = db
      .prepare(`SELECT COUNT(DISTINCT note_id) AS count FROM entity_mentions WHERE entity_id = ?`)
      .get(id) as { count: number }
    return { count }
  })

  /**
   * entities:get-trash-status — batch check which entity IDs are trashed.
   * Input: { ids: string[] }
   * Returns: Record<string, boolean> mapping id → is_trashed
   */
  ipcMain.handle('entities:get-trash-status', (_event, { ids }: { ids: string[] }) => {
    if (!ids.length) return {}
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(
        `SELECT id, trashed_at FROM entities WHERE id IN (${placeholders})`
      )
      .all(...ids) as { id: string; trashed_at: string | null }[]
    const result: Record<string, boolean> = {}
    for (const row of rows) {
      result[row.id] = row.trashed_at !== null
    }
    return result
  })

  /**
   * entities:find-by-email — look up a non-trashed entity by an email field value.
   * Used by SyncedEventPopup to match attendee emails to entities.
   * Input:  { email: string, type_id: string, email_field: string }
   * Returns: { id, name, type_id } or null
   */
  ipcMain.handle(
    'entities:find-by-email',
    (_event, { email, type_id, email_field }: { email: string; type_id: string; email_field: string }) => {
      const db = getDatabase()
      // JSON_EXTRACT accepts the path as a parameter — safe to pass field key here
      const path = `$.${email_field}`
      return db
        .prepare(
          `SELECT id, name, type_id FROM entities
           WHERE type_id = ? AND trashed_at IS NULL AND JSON_EXTRACT(fields, ?) = ?
           LIMIT 1`,
        )
        .get(type_id, path, email) as { id: string; name: string; type_id: string } | null ?? null
    },
  )

  /**
   * entities:computed-query — execute a WQL query scoped to a specific entity.
   * Input:  { query: string, thisId: string }
   * Returns: { ok: true, results: EntityRef[] } | { ok: false, error: string }
   */
  ipcMain.handle(
    'entities:computed-query',
    (_event, { query, thisId }: { query: string; thisId: string }) => {
      try {
        const db = getDatabase()
        const ast = parseQuery(query)
        const results = evalQuery(db, ast, thisId)
        return { ok: true, results }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }
  )

  /**
   * entities:parse-query — validate a WQL query without executing it.
   * Input:  { query: string }
   * Returns: { ok: true } | { ok: false, error: string }
   * Used by QueryFieldEditor to show inline parse errors while typing.
   */
  ipcMain.handle('entities:parse-query', (_event, { query }: { query: string }) => {
    try {
      parseQuery(query)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  // ─── Note Templates ──────────────────────────────────────────────────────────

  /** templates:list — returns all note templates sorted by name. */
  ipcMain.handle('templates:list', () => {
    const db = getDatabase()
    return db
      .prepare(`SELECT * FROM note_templates ORDER BY name COLLATE NOCASE`)
      .all() as NoteTemplateRow[]
  })

  /** templates:create — creates a new note template. */
  ipcMain.handle(
    'templates:create',
    (_event, { name, icon, body }: { name: string; icon: string; body: string }) => {
      const db = getDatabase()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO note_templates (id, name, icon, body) VALUES (?, ?, ?, ?)`
      ).run(id, name, icon, body)
      return db.prepare('SELECT * FROM note_templates WHERE id = ?').get(id) as NoteTemplateRow
    }
  )

  /** templates:get — returns a single template by id, or null. */
  ipcMain.handle('templates:get', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    return (db.prepare('SELECT * FROM note_templates WHERE id = ?').get(id) as NoteTemplateRow) ?? null
  })

  /** templates:update — updates name, icon, and body for a template. */
  ipcMain.handle(
    'templates:update',
    (_event, { id, name, icon, body }: { id: string; name: string; icon: string; body: string }) => {
      const db = getDatabase()
      db.prepare(`UPDATE note_templates SET name = ?, icon = ?, body = ? WHERE id = ?`).run(name, icon, body, id)
      return { ok: true }
    }
  )

  /** templates:delete — permanently deletes a template. */
  ipcMain.handle('templates:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    db.prepare(`DELETE FROM note_templates WHERE id = ?`).run(id)
    return { ok: true }
  })

  /**
   * trash:list — returns all trashed notes and entities.
   */
  ipcMain.handle('trash:list', () => {
    const db = getDatabase()
    const notes = db
      .prepare(
        `SELECT id, title, archived_at FROM notes
         WHERE archived_at IS NOT NULL ORDER BY archived_at DESC`
      )
      .all() as { id: string; title: string; archived_at: string }[]

    const entities = db
      .prepare(
        `SELECT e.id, e.name, e.trashed_at, e.type_id,
                et.name AS type_name, et.icon AS type_icon, et.color AS type_color
         FROM entities e
         JOIN entity_types et ON e.type_id = et.id
         WHERE e.trashed_at IS NOT NULL
         ORDER BY e.trashed_at DESC`
      )
      .all() as {
        id: string
        name: string
        trashed_at: string
        type_id: string
        type_name: string
        type_icon: string
        type_color: string | null
      }[]

    return { notes, entities }
  })

  // ─── Action Items ─────────────────────────────────────────────────────────────

  /**
   * action-items:list — returns action items, optionally filtered by status or source note.
   * Non-cancelled items are returned by default. Includes source note title and assignee name.
   */
  ipcMain.handle('action-items:list', (_event, opts?: { status?: string; source_note_id?: string }) => {
    const db = getDatabase()
    const SELECT = `
      SELECT ai.id, ai.title, ai.status, ai.extraction_type, ai.confidence,
             ai.created_at, ai.completed_at, ai.source_note_id, ai.assigned_entity_id, ai.due_date,
             n.title AS source_note_title, e.name AS assigned_entity_name
      FROM action_items ai
      LEFT JOIN notes n ON ai.source_note_id = n.id
      LEFT JOIN entities e ON ai.assigned_entity_id = e.id`

    if (opts?.source_note_id) {
      return db
        .prepare(`${SELECT} WHERE ai.source_note_id = ? AND ai.status != 'cancelled' ORDER BY ai.created_at DESC`)
        .all(opts.source_note_id)
    }
    if (opts?.status) {
      return db
        .prepare(`${SELECT} WHERE ai.status = ? ORDER BY ai.created_at DESC`)
        .all(opts.status)
    }
    return db
      .prepare(`${SELECT} WHERE ai.status != 'cancelled' ORDER BY ai.created_at DESC`)
      .all()
  })

  /** action-items:create — creates a new action item and returns the full row with joins. */
  ipcMain.handle(
    'action-items:create',
    (
      _event,
      opts: {
        title: string
        source_note_id?: string | null
        assigned_entity_id?: string | null
        due_date?: string | null
        extraction_type?: string
        confidence?: number
      }
    ) => {
      const db = getDatabase()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO action_items (id, title, source_note_id, assigned_entity_id, due_date, extraction_type, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        opts.title,
        opts.source_note_id ?? null,
        opts.assigned_entity_id ?? null,
        opts.due_date ?? null,
        opts.extraction_type ?? 'manual',
        opts.confidence ?? 1.0
      )
      const row = db
        .prepare(
          `SELECT ai.id, ai.title, ai.status, ai.extraction_type, ai.confidence,
                  ai.created_at, ai.completed_at, ai.source_note_id, ai.assigned_entity_id, ai.due_date,
                  n.title AS source_note_title, e.name AS assigned_entity_name
           FROM action_items ai
           LEFT JOIN notes n ON ai.source_note_id = n.id
           LEFT JOIN entities e ON ai.assigned_entity_id = e.id
           WHERE ai.id = ?`
        )
        .get(id)
      pushToRenderer('action:created', { actionId: id })
      return row
    }
  )

  /** action-items:update — updates status, title, assignee, or due date. */
  ipcMain.handle(
    'action-items:update',
    (
      _event,
      opts: {
        id: string
        title?: string
        status?: string
        assigned_entity_id?: string | null
        due_date?: string | null
      }
    ) => {
      const db = getDatabase()
      const sets: string[] = []
      const params: unknown[] = []

      if (opts.title !== undefined) {
        sets.push('title = ?')
        params.push(opts.title)
      }
      if (opts.status !== undefined) {
        sets.push('status = ?')
        params.push(opts.status)
        if (opts.status === 'done' || opts.status === 'cancelled') {
          sets.push("completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
        } else {
          sets.push('completed_at = NULL')
        }
      }
      if ('assigned_entity_id' in opts) {
        sets.push('assigned_entity_id = ?')
        params.push(opts.assigned_entity_id ?? null)
      }
      if ('due_date' in opts) {
        sets.push('due_date = ?')
        params.push(opts.due_date ?? null)
      }

      if (!sets.length) return { ok: true }
      sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
      params.push(opts.id)
      db.prepare(`UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`).run(...(params as (string | number | null)[]))

      if (opts.status !== undefined) {
        const row = db
          .prepare('SELECT source_note_id FROM action_items WHERE id = ?')
          .get(opts.id) as { source_note_id: string | null } | undefined
        pushToRenderer('action:status-changed', {
          actionId: opts.id,
          status: opts.status,
          sourceNoteId: row?.source_note_id ?? null,
        })
      }

      return { ok: true }
    }
  )

  /**
   * notes:extract-actions — uses Claude Haiku to extract action items from note body_plain.
   * Called on-demand by the /action slash command in the editor.
   * Returns { heading: string, items: string[] } — heading and titles are in the note's language.
   */
  ipcMain.handle('notes:extract-actions', async (_event, { body_plain }: { body_plain: string }) => {
    const db = getDatabase()
    const setting = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('anthropic_api_key') as { value: string } | undefined
    const apiKey = setting?.value ?? ''
    if (!apiKey) return { heading: 'Action Items', items: [] }
    const bgModelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('model_background') as { value: string } | undefined
    const bgModel = bgModelRow?.value || 'claude-haiku-4-5-20251001'
    try {
      const extracted = await extractActionItems('', body_plain, apiKey, bgModel)
      return { heading: extracted.heading, items: extracted.items.map((e) => e.title) }
    } catch {
      return { heading: 'Action Items', items: [] }
    }
  })

  /**
   * notes:ai-inline — generate inline content to insert or replace in the note editor.
   *
   * Input:  { prompt, noteBodyPlain, selectedText?, mentionedEntityIds?, mentionedNoteIds?, images? }
   * Output: { content: TipTapNode[] } or { error: string }
   *
   * Flow:
   *   1. Read anthropic_api_key from settings; return { error } if missing.
   *   2. FTS5 keyword search on prompt (top 5) for knowledge base context.
   *   3. Fetch entity fields for each mentionedEntityId → entityContext.
   *   4. Fetch body_plain for each mentionedNoteId → append to contextNotes.
   *   5. Call generateInlineContent() → markdown string.
   *   6. Parse markdown → TipTap nodes via parseMarkdownToTipTap().
   *   7. Return { content }.
   */
  ipcMain.handle(
    'notes:ai-inline',
    async (
      _event,
      {
        prompt,
        noteBodyPlain,
        selectedText,
        mentionedEntityIds,
        mentionedNoteIds,
        images,
        files,
      }: {
        prompt: string
        noteBodyPlain: string
        selectedText?: string
        mentionedEntityIds?: string[]
        mentionedNoteIds?: string[]
        images?: { dataUrl: string; mimeType: string }[]
        files?: { name: string; content: string; mimeType: 'application/pdf' | 'text/plain' }[]
      },
    ): Promise<{ content: object[] } | { error: string }> => {
      const db = getDatabase()

      const setting = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('anthropic_api_key') as { value: string } | undefined
      const apiKey = setting?.value ?? ''
      if (!apiKey) {
        return {
          error:
            'No Anthropic API key configured. Add your API key in Settings → AI to use inline generation.',
        }
      }

      const bgModelRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('model_background') as { value: string } | undefined
      const bgModel = bgModelRow?.value || 'claude-haiku-4-5-20251001'

      setChatAnthropicKey(apiKey)

      // FTS5 keyword search on the prompt for knowledge base context (top 5 notes)
      const contextNotes: { title: string; excerpt: string }[] = []
      if (prompt.trim()) {
        try {
          const keywords = prompt
            .split(/\s+/)
            .filter((w) => w.length >= 3)
            .slice(0, 8)
          if (keywords.length > 0) {
            const ftsQuery = keywords
              .map((w) => w.replace(/["\(\)\^\*\+\-]/g, ''))
              .filter(Boolean)
              .join(' OR ')
            if (ftsQuery) {
              const rows = db
                .prepare(
                  `SELECT n.title, n.body_plain
                   FROM notes_fts
                   JOIN notes n ON n.rowid = notes_fts.rowid
                   WHERE notes_fts MATCH ? AND n.archived_at IS NULL
                   ORDER BY rank LIMIT 5`,
                )
                .all(ftsQuery) as { title: string; body_plain: string }[]
              for (const row of rows) {
                contextNotes.push({
                  title: row.title,
                  excerpt:
                    row.body_plain.length > 500
                      ? row.body_plain.slice(0, 500) + '…'
                      : row.body_plain,
                })
              }
            }
          }
        } catch {
          // FTS error — proceed without context
        }
      }

      // Fetch rich entity context with BFS field expansion for explicitly @mentioned entities
      let richEntities: RichEntityContext[] = []
      if (mentionedEntityIds && mentionedEntityIds.length > 0) {
        try {
          const { richEntities: re, entityLinkedNoteIds } = buildRichEntityContext(db, mentionedEntityIds)
          richEntities = re

          // Fetch body_plain for entity-linked notes and add to context
          const linkNoteIds = [...entityLinkedNoteIds].slice(0, 3)
          if (linkNoteIds.length > 0) {
            const placeholders = linkNoteIds.map(() => '?').join(', ')
            const noteRows = db
              .prepare(
                `SELECT title, body_plain FROM notes WHERE id IN (${placeholders}) AND archived_at IS NULL`,
              )
              .all(...linkNoteIds) as { title: string; body_plain: string }[]
            for (const nr of noteRows) {
              contextNotes.push({
                title: nr.title,
                excerpt: nr.body_plain.length > 800 ? nr.body_plain.slice(0, 800) + '…' : nr.body_plain,
              })
            }
          }
        } catch {
          // entity fetch error — proceed without entity context
        }
      }

      // Fetch body_plain for explicitly [[linked]] notes (append to context)
      if (mentionedNoteIds && mentionedNoteIds.length > 0) {
        try {
          const placeholders = mentionedNoteIds.map(() => '?').join(', ')
          const rows = db
            .prepare(
              `SELECT title, body_plain FROM notes
               WHERE id IN (${placeholders}) AND archived_at IS NULL`,
            )
            .all(...mentionedNoteIds) as { title: string; body_plain: string }[]
          for (const row of rows) {
            const excerpt =
              row.body_plain.length > 800
                ? row.body_plain.slice(0, 800) + '…'
                : row.body_plain
            // prepend explicitly-linked notes so they rank highest in context
            contextNotes.unshift({ title: row.title, excerpt })
          }
        } catch {
          // note fetch error — proceed without explicit note context
        }
      }

      try {
        const markdown = await generateInlineContent(
          prompt,
          noteBodyPlain,
          selectedText,
          contextNotes,
          bgModel,
          richEntities.length > 0 ? richEntities : undefined,
          images && images.length > 0 ? images as { dataUrl: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }[] : undefined,
          files && files.length > 0 ? files : undefined,
        )
        if (!markdown) {
          return { error: 'AI returned empty content. Please try a different prompt.' }
        }

        // Scan generated markdown for @EntityName / [[NoteTitle]] tokens,
        // batch-resolve them against the DB, and build a ParseContext so the
        // parser can emit interactive mention / noteLink TipTap nodes.
        const entityNames = new Set<string>()
        const noteTitles = new Set<string>()
        for (const m of markdown.matchAll(/@([A-Za-z\u00C0-\u04FF][^\s@,.:!?"()\[\]{}<>#\n]{0,59})/g)) {
          entityNames.add(m[1].replace(/[.,!?;:'")\]]+$/, '').trim())
        }
        for (const m of markdown.matchAll(/\[\[([^\]]{1,200})\]\]/g)) {
          noteTitles.add(m[1].trim())
        }

        const entityMap = new Map<string, { id: string; label: string }>()
        const noteMap   = new Map<string, { id: string; label: string }>()

        if (entityNames.size > 0) {
          const ph = Array.from(entityNames).map(() => '?').join(',')
          const rows = db.prepare(
            `SELECT id, name FROM entities WHERE name IN (${ph}) AND trashed_at IS NULL`,
          ).all(...Array.from(entityNames)) as { id: string; name: string }[]
          for (const r of rows) entityMap.set(r.name, { id: r.id, label: r.name })
        }
        if (noteTitles.size > 0) {
          const ph = Array.from(noteTitles).map(() => '?').join(',')
          const rows = db.prepare(
            `SELECT id, title FROM notes WHERE title IN (${ph}) AND archived_at IS NULL`,
          ).all(...Array.from(noteTitles)) as { id: string; title: string }[]
          for (const r of rows) noteMap.set(r.title, { id: r.id, label: r.title })
        }

        const parseCtx: ParseContext = {
          resolveEntity: (name)  => entityMap.get(name)  ?? null,
          resolveNote:   (title) => noteMap.get(title)   ?? null,
        }

        const nodes = parseMarkdownToTipTap(markdown, parseCtx)
        return { content: nodes }
      } catch (err) {
        console.error('[AI Inline] Generation failed:', err)
        return { error: 'AI generation failed. Please check your API key and try again.' }
      }
    },
  )

  /** action-items:get-statuses — batch-fetch status for a list of action item IDs. */
  ipcMain.handle('action-items:get-statuses', (_event, { ids }: { ids: string[] }) => {
    if (!ids.length) return {}
    const db = getDatabase()
    const placeholders = ids.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT id, status FROM action_items WHERE id IN (${placeholders})`)
      .all(...(ids as (string | number | null)[])) as { id: string; status: string }[]
    return Object.fromEntries(rows.map((r) => [r.id, r.status]))
  })

  /** action-items:delete — permanently deletes an action item.
   *  If the action was linked to a taskItem node in a note (via actionId attribute),
   *  clears that attribute in the note body before deleting. */
  ipcMain.handle('action-items:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()

    // Look up the source note so we can clear the dangling actionId attribute.
    const actionRow = db
      .prepare('SELECT source_note_id FROM action_items WHERE id = ?')
      .get(id) as { source_note_id: string | null } | undefined

    const noteId = actionRow?.source_note_id ?? null

    if (noteId) {
      const noteRow = db
        .prepare('SELECT body FROM notes WHERE id = ?')
        .get(noteId) as { body: string } | undefined

      if (noteRow?.body) {
        try {
          const doc = JSON.parse(noteRow.body) as Record<string, unknown>
          let modified = false

          function clearActionId(node: Record<string, unknown>): void {
            if (
              node.type === 'taskItem' &&
              (node.attrs as Record<string, unknown> | undefined)?.actionId === id
            ) {
              ;(node.attrs as Record<string, unknown>).actionId = null
              modified = true
            }
            const children = node.content as Record<string, unknown>[] | undefined
            if (Array.isArray(children)) children.forEach(clearActionId)
          }

          clearActionId(doc)

          if (modified) {
            db.prepare(
              `UPDATE notes SET body = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
            ).run(JSON.stringify(doc), noteId)
          }
        } catch {
          // Malformed body JSON — proceed with deletion anyway.
        }
      }
    }

    db.prepare('DELETE FROM action_items WHERE id = ?').run(id)

    if (noteId) pushToRenderer('action:unlinked', { actionId: id, noteId })

    return { ok: true }
  })

  // ─── Settings ────────────────────────────────────────────────────────────────

  /** settings:get — returns the stored value for a key, or null if unset. */
  ipcMain.handle('settings:get', (_event, { key }: { key: string }) => {
    const db = getDatabase()
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined
    return row?.value ?? null
  })

  /**
   * settings:set — upserts a key/value pair.
   * When the OpenAI API key is updated, also refreshes the embedder client
   * so the next embedding run picks up the new key immediately.
   */
  ipcMain.handle('settings:set', (_event, { key, value }: { key: string; value: string }) => {
    const db = getDatabase()
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(key, value)

    if (key === 'openai_api_key') {
      import('../embedding/embedder')
        .then(({ setOpenAIKey: sk }) => sk(value))
        .catch(() => { /* embedder not yet loaded — pipeline will read key on next run */ })
    }

    return { ok: true }
  })

  // ─── Semantic search ──────────────────────────────────────────────────────────

  /**
   * notes:semantic-search — hybrid FTS5 + vector search with Reciprocal Rank Fusion,
   * query expansion, and Claude Haiku re-ranking.
   *
   * Flow (when sqlite-vec + OpenAI key + Anthropic key are all configured):
   *   1. Query expansion (Claude Haiku) + embedding in parallel
   *      — generates synonyms/related concepts for broader FTS recall
   *   2. FTS5 keyword search (top 20, using expanded terms) + KNN vector (top 20)
   *   3. Merge via RRF: score = Σ 1/(60 + rank) across both lists + L3 cluster boost
   *   4. Re-rank top 15 with Claude Haiku relevance scoring
   *
   * Graceful degradation:
   *   - No Anthropic key: skip expansion (raw FTS) and skip re-ranking
   *   - No vec / no OpenAI key: FTS-only, up to 15 results, no excerpt
   *
   * Input:  { query: string }
   * Output: { id, title, excerpt: string | null }[]  (up to 15 notes)
   */
  ipcMain.handle(
    'notes:semantic-search',
    async (_event, { query }: { query: string }): Promise<{ id: string; title: string; excerpt: string | null }[]> => {
      const db = getDatabase()

      // Sanitize raw query for FTS5 fallback — strip operators/special chars that cause parse errors
      const rawFtsQuery = query
        .replace(/["\(\)\^\*\+\-]/g, ' ')
        .replace(/\b(AND|OR|NOT)\b/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')

      const runFts = (q: string, limit: number): { id: string; title: string }[] => {
        if (!q) return []
        try {
          return db
            .prepare(
              `SELECT n.id, n.title
               FROM notes_fts
               JOIN notes n ON n.rowid = notes_fts.rowid
               WHERE notes_fts MATCH ? AND n.archived_at IS NULL
               ORDER BY rank LIMIT ${limit}`
            )
            .all(q) as { id: string; title: string }[]
        } catch {
          return []
        }
      }

      // Read Anthropic key for query expansion + re-ranking (non-critical if absent)
      let anthropicKey = ''
      try {
        const anthSetting = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('anthropic_api_key') as { value: string } | undefined
        anthropicKey = anthSetting?.value ?? ''
        if (anthropicKey) setChatAnthropicKey(anthropicKey)
      } catch {
        // no-op — expansion and re-ranking will be skipped
      }

      let searchBgModel = 'claude-haiku-4-5-20251001'
      try {
        const bgModelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('model_background') as { value: string } | undefined
        searchBgModel = bgModelRow?.value || 'claude-haiku-4-5-20251001'
      } catch { /* no-op */ }

      if (isVecLoaded()) {
        const setting = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('openai_api_key') as { value: string } | undefined
        const apiKey = setting?.value ?? ''

        if (apiKey) {
          try {
            setOpenAIKey(apiKey)

            // Step 1: query expansion + embedding in parallel
            const [expandedTerms, [embed]] = await Promise.all([
              anthropicKey
                ? expandQueryConcepts(query, searchBgModel)
                : Promise.resolve(rawFtsQuery.split(/\s+/).filter((w) => w.length >= 2)),
              embedTexts([query]),
            ])
            const queryBuf = Buffer.from(embed.embedding.buffer)

            // Build FTS query from expanded terms; fall back to raw query if expansion yields nothing
            const expandedFtsQuery = expandedTerms
              .map((w) => w.replace(/["\(\)\^\*\+\-]/g, ''))
              .filter(Boolean)
              .join(' OR ')

            // L3 cluster boost — find top 3 matching clusters, collect all their member note IDs.
            // Wrapped in try/catch: cluster_embeddings is empty until the first nightly batch runs.
            const clusterBoostSet = new Set<string>()
            try {
              const clusterRows = db
                .prepare(
                  'SELECT rowid, distance FROM cluster_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 3'
                )
                .all(queryBuf) as { rowid: number; distance: number }[]
              for (const { rowid } of clusterRows) {
                const chunk = db
                  .prepare('SELECT chunk_context FROM note_chunks WHERE id = ? AND layer = 3')
                  .get(rowid) as { chunk_context: string } | undefined
                if (!chunk?.chunk_context) continue
                try {
                  const members = JSON.parse(chunk.chunk_context) as string[]
                  for (const id of members) clusterBoostSet.add(id)
                } catch {
                  // malformed chunk_context — skip
                }
              }
            } catch {
              // cluster_embeddings empty or not ready — no-op
            }

            // KNN: top 20 chunks by cosine similarity
            const knnRows = db
              .prepare('SELECT rowid, distance FROM chunk_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT 20')
              .all(queryBuf) as { rowid: number; distance: number }[]

            // Resolve chunks → notes (keep first/best chunk per note)
            const vectorHits: { id: string; title: string; excerpt: string }[] = []
            const seenVec = new Set<string>()
            for (const { rowid } of knnRows) {
              const row = db
                .prepare(
                  `SELECT nc.note_id, n.title, nc.chunk_text
                   FROM note_chunks nc
                   JOIN notes n ON n.id = nc.note_id
                   WHERE nc.id = ? AND n.archived_at IS NULL`
                )
                .get(rowid) as { note_id: string; title: string; chunk_text: string } | undefined
              if (!row || seenVec.has(row.note_id)) continue
              seenVec.add(row.note_id)
              vectorHits.push({ id: row.note_id, title: row.title, excerpt: row.chunk_text })
            }

            // FTS with expanded terms; fall back to raw sanitized query if expansion yields no hits
            let ftsHits = runFts(expandedFtsQuery, 20)
            if (ftsHits.length === 0) ftsHits = runFts(rawFtsQuery, 20)

            // Reciprocal Rank Fusion (k = 60 is the standard constant)
            const K = 60
            const candidates = new Map<string, { id: string; title: string; excerpt: string | null; score: number }>()

            ftsHits.forEach((row, idx) => {
              candidates.set(row.id, { id: row.id, title: row.title, excerpt: null, score: 1 / (K + idx + 1) })
            })

            vectorHits.forEach((hit, idx) => {
              const s = 1 / (K + idx + 1)
              const existing = candidates.get(hit.id)
              if (existing) {
                existing.score += s
                existing.excerpt ??= hit.excerpt
              } else {
                candidates.set(hit.id, { id: hit.id, title: hit.title, excerpt: hit.excerpt, score: s })
              }
            })

            // Apply cluster boost: notes in top-matching clusters get a small score bump.
            // +0.05 is meaningful vs typical RRF scores (~0.015–0.033) but not overpowering.
            if (clusterBoostSet.size > 0) {
              for (const [noteId, c] of candidates) {
                if (clusterBoostSet.has(noteId)) c.score += 0.05
              }
            }

            // LIKE substring fallback — catches notes missed by FTS (tokenisation mismatch,
            // e.g. Polish inflections where expanded term "morze" doesn't substring-match "Morza")
            // or notes without embeddings that the vector search can't reach.
            // Triggered when we have fewer than 10 candidates; adds new notes with a minimum
            // score so the Claude Haiku re-ranker can still surface truly relevant ones.
            if (candidates.size < 10) {
              for (const term of expandedTerms.slice(0, 5)) {
                if (candidates.size >= 15) break
                try {
                  const likeRows = db
                    .prepare(
                      `SELECT id, title, body_plain FROM notes
                       WHERE (LOWER(body_plain) LIKE ? OR LOWER(title) LIKE ?) AND archived_at IS NULL
                       LIMIT 5`
                    )
                    .all(`%${term.toLowerCase()}%`, `%${term.toLowerCase()}%`) as { id: string; title: string; body_plain: string }[]
                  for (const row of likeRows) {
                    if (candidates.has(row.id)) continue
                    const excerpt = row.body_plain.length > 300 ? row.body_plain.slice(0, 300) + '…' : row.body_plain
                    candidates.set(row.id, {
                      id: row.id,
                      title: row.title,
                      excerpt,
                      score: 1 / (K + 21), // min RRF-equivalent — re-ranker can still elevate
                    })
                  }
                } catch {
                  // ignore per-term errors
                }
              }
            }

            const rrfSorted = [...candidates.values()]
              .sort((a, b) => b.score - a.score)
              .slice(0, 15)

            // Step 4: Re-rank with Claude Haiku (if Anthropic key available)
            const reranked =
              anthropicKey && rrfSorted.length > 1
                ? await reRankResults(query, rrfSorted, searchBgModel)
                : rrfSorted

            return reranked.map(({ id, title, excerpt }) => ({ id, title, excerpt }))
          } catch (err) {
            console.error('[Search] Hybrid search error — falling back to FTS:', err)
          }
        }
      }

      // FTS-only fallback (no vec / no API key / error above)
      return runFts(rawFtsQuery, 15).map((r) => ({ ...r, excerpt: null }))
    }
  )

  // ─── AI Chat ──────────────────────────────────────────────────────────────────

  /**
   * chat:send — answer a user question using the knowledge base as context.
   *
   * Flow:
   *   1. Read anthropic_api_key from settings; return graceful message if missing.
   *   2. FTS5 search on the last user message (top 5) as knowledge base context.
   *   3. Call Claude with conversation history + context injected into system prompt.
   *   4. Parse [Note: "Title"] citations from the response; resolve to {id, title}.
   *   5. Return { content, references }.
   *
   * Input:  { messages: {role, content}[], searchQuery?: string }
   * Output: { content: string, references: {id: string, title: string}[] }
   */
  ipcMain.handle(
    'chat:send',
    async (
      _event,
      {
        messages,
        searchQuery,
        images,
        files,
        model,
        mentionedEntityIds,
        mentionedNoteIds,
      }: {
        messages: { role: 'user' | 'assistant'; content: string }[]
        searchQuery?: string
        images?: { dataUrl: string; mimeType: string }[]
        files?: { name: string; content: string; mimeType: 'application/pdf' | 'text/plain' }[]
        model?: string
        mentionedEntityIds?: string[]
        mentionedNoteIds?: string[]
      },
    ): Promise<{ content: string; references: { id: string; title: string }[]; actions: ExecutedAction[]; entityRefs: { id: string; name: string }[] }> => {
      const db = getDatabase()

      const setting = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('anthropic_api_key') as { value: string } | undefined
      const apiKey = setting?.value ?? ''

      if (!apiKey) {
        return {
          content:
            'No Anthropic API key configured. Open **Settings** (bottom of the sidebar) and add your API key to enable AI chat.',
          references: [],
          actions: [],
          entityRefs: [],
        }
      }

      const chatModelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('model_chat') as { value: string } | undefined
      const chatModel = (model as ChatModelId | undefined) ?? (chatModelRow?.value as ChatModelId | undefined) ?? 'claude-sonnet-4-6'

      const chatBgModelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('model_background') as { value: string } | undefined
      const chatBgModel = chatBgModelRow?.value || 'claude-haiku-4-5-20251001'

      setChatAnthropicKey(apiKey)

      // Use the last user message as the search query if not explicitly provided
      const query =
        searchQuery ??
        [...messages].reverse().find((m) => m.role === 'user')?.content ??
        ''

      // Retrieve knowledge base context for the question.
      //
      // Step 1: Claude Haiku extracts base-form keywords — language-agnostic, handles
      //         morphology (e.g. Polish "Bifroście" → keyword "Bifrost").
      // Step 2: FTS5 OR search on those keywords (ranked, good for ASCII/English).
      // Step 3: LIKE substring fallback for any keywords not yet covered — handles
      //         inflected forms and non-ASCII characters that FTS5 may tokenize differently.
      const contextNotes: { id: string; title: string; excerpt: string }[] = []
      const seen = new Set<string>()
      if (query.trim()) {
        // Pass prior messages so Haiku can resolve follow-ups ("a kiedy to bylo?" → "Bifrost")
        const keywords = await extractSearchKeywords(query, messages.slice(0, -1), chatBgModel)

        if (keywords.length > 0) {
          function addNote(row: { id: string; title: string; body_plain: string }): void {
            if (seen.has(row.id) || contextNotes.length >= 5) return
            seen.add(row.id)
            contextNotes.push({
              id: row.id,
              title: row.title,
              excerpt: row.body_plain.length > 600 ? row.body_plain.slice(0, 600) + '…' : row.body_plain,
            })
          }

          // FTS5 OR — any keyword match surfaces the note, ranked by relevance
          try {
            const ftsQuery = keywords
              .map((w) => w.replace(/["\(\)\^\*\+\-]/g, ''))
              .filter(Boolean)
              .join(' OR ')

            if (ftsQuery) {
              const ftsRows = db
                .prepare(
                  `SELECT n.id, n.title, n.body_plain
                   FROM notes_fts
                   JOIN notes n ON n.rowid = notes_fts.rowid
                   WHERE notes_fts MATCH ? AND n.archived_at IS NULL
                   ORDER BY rank LIMIT 5`,
                )
                .all(ftsQuery) as { id: string; title: string; body_plain: string }[]

              for (const row of ftsRows) addNote(row)
            }
          } catch {
            // FTS error — continue to LIKE fallback
          }

          // LIKE fallback — substring match handles inflected/non-ASCII forms FTS5 may miss
          if (contextNotes.length < 5) {
            for (const keyword of keywords) {
              if (contextNotes.length >= 5) break
              try {
                const likeRows = db
                  .prepare(
                    `SELECT id, title, body_plain FROM notes
                     WHERE LOWER(body_plain) LIKE ? AND archived_at IS NULL
                     LIMIT 3`,
                  )
                  .all(`%${keyword.toLowerCase()}%`) as { id: string; title: string; body_plain: string }[]

                for (const row of likeRows) addNote(row)
              } catch {
                // ignore per-keyword failures
              }
            }
          }
        }
      }

      // ── Graph RAG expansion ─────────────────────────────────────────────
      // Expand context by 1 hop in the knowledge graph using two queries:
      //  A) Direct [[wiki-link]] neighbors (bidirectional) via note_relations
      //  B) Entity co-occurrence neighbors (same @mentions) via entity_mentions
      // Both rank by overlap count (how many seeds share the connection).
      // Budget: up to 5 per query. Global dedup via the hoisted `seen` Set.
      if (contextNotes.length > 0) {
        try {
          const seedIds = contextNotes.map((n) => n.id)
          const sp = seedIds.map(() => '?').join(',')

          function addGraphNote(row: { id: string; title: string; body_plain: string }): boolean {
            if (seen.has(row.id)) return false
            seen.add(row.id)
            contextNotes.push({
              id: row.id,
              title: row.title,
              excerpt: row.body_plain.length > 600 ? row.body_plain.slice(0, 600) + '…' : row.body_plain,
            })
            return true
          }

          // Query A: bidirectional 1-hop link neighbors
          const directRows = db
            .prepare(
              `SELECT n.id, n.title, n.body_plain, COUNT(*) AS overlap
               FROM (
                 SELECT target_note_id AS neighbor_id FROM note_relations WHERE source_note_id IN (${sp})
                 UNION ALL
                 SELECT source_note_id AS neighbor_id FROM note_relations WHERE target_note_id IN (${sp})
               ) edges
               JOIN notes n ON n.id = edges.neighbor_id
               WHERE n.archived_at IS NULL
               GROUP BY n.id ORDER BY overlap DESC LIMIT 5`,
            )
            .all(...seedIds, ...seedIds) as { id: string; title: string; body_plain: string; overlap: number }[]

          let da = 0
          for (const row of directRows) {
            if (da >= 5) break
            if (addGraphNote(row)) da++
          }

          // Query B: entity co-occurrence neighbors
          const cooccRows = db
            .prepare(
              `SELECT n.id, n.title, n.body_plain, COUNT(DISTINCT em2.entity_id) AS overlap
               FROM entity_mentions em1
               JOIN entity_mentions em2 ON em2.entity_id = em1.entity_id
                 AND em2.note_id NOT IN (${sp})
               JOIN notes n ON n.id = em2.note_id
               WHERE em1.note_id IN (${sp}) AND n.archived_at IS NULL
               GROUP BY n.id ORDER BY overlap DESC LIMIT 5`,
            )
            .all(...seedIds, ...seedIds) as { id: string; title: string; body_plain: string; overlap: number }[]

          let co = 0
          for (const row of cooccRows) {
            if (co >= 5) break
            if (addGraphNote(row)) co++
          }
        } catch (err) {
          console.warn('[Chat] Graph RAG expansion error:', err)
        }
      }
      // ── End Graph RAG expansion ──────────────────────────────────────────

      // Fetch calendar events (past 7 days → next 30 days) for temporal awareness
      const calendarEvents: CalendarEventContext[] = (() => {
        try {
          const now = new Date()
          const rangeStart = new Date(now)
          rangeStart.setDate(rangeStart.getDate() - 7)
          const rangeEnd = new Date(now)
          rangeEnd.setDate(rangeEnd.getDate() + 30)
          return db
            .prepare(
              `SELECT ce.id, ce.title, ce.start_at, ce.end_at, ce.attendees,
                      ce.linked_note_id, n.title as linked_note_title
               FROM calendar_events ce
               LEFT JOIN notes n ON n.id = ce.linked_note_id
               WHERE ce.start_at >= ? AND ce.start_at <= ?
               ORDER BY ce.start_at ASC
               LIMIT 50`,
            )
            .all(rangeStart.toISOString(), rangeEnd.toISOString()) as CalendarEventContext[]
        } catch {
          return []
        }
      })()

      // Fetch open/in-progress action items
      const actionItems: ActionItemContext[] = (() => {
        try {
          return db
            .prepare(
              `SELECT ai.id, ai.title, ai.status, ai.due_date,
                      e.name as assigned_entity_name,
                      ai.source_note_id, n.title as source_note_title
               FROM action_items ai
               LEFT JOIN entities e ON e.id = ai.assigned_entity_id
               LEFT JOIN notes n ON n.id = ai.source_note_id
               WHERE ai.status IN ('open', 'in_progress')
               ORDER BY ai.due_date ASC NULLS LAST, ai.created_at DESC
               LIMIT 50`,
            )
            .all() as ActionItemContext[]
        } catch {
          return []
        }
      })()

      // Fetch full content of notes explicitly pinned via [[ in the chat input
      const pinnedNotes: EntityLinkedNote[] = (() => {
        if (!mentionedNoteIds?.length) return []
        try {
          const sp = mentionedNoteIds.map(() => '?').join(',')
          const rows = db
            .prepare(
              `SELECT id, title, body_plain FROM notes
               WHERE id IN (${sp}) AND archived_at IS NULL`,
            )
            .all(...mentionedNoteIds) as { id: string; title: string; body_plain: string }[]
          return rows.map((r) => ({
            id: r.id,
            title: r.title,
            excerpt: r.body_plain.length > 4000 ? r.body_plain.slice(0, 4000) + '…' : r.body_plain,
          }))
        } catch {
          return []
        }
      })()

      // Fetch rich entity context with BFS field expansion for entities mentioned in conversation
      let richEntities: RichEntityContext[] = []
      let entityLinkedNotes: EntityLinkedNote[] = []
      if (mentionedEntityIds?.length) {
        try {
          const { richEntities: re, entityLinkedNoteIds } = buildRichEntityContext(db, mentionedEntityIds)
          richEntities = re

          // Fetch body_plain for entity-linked notes; skip any already pinned by the user
          const pinnedNoteIdSet = new Set(pinnedNotes.map((n) => n.id))
          const linkNoteIds = [...entityLinkedNoteIds].filter((id) => !pinnedNoteIdSet.has(id)).slice(0, 3)
          if (linkNoteIds.length) {
            const sp2 = linkNoteIds.map(() => '?').join(',')
            const rows = db
              .prepare(`SELECT id, title, body_plain FROM notes WHERE id IN (${sp2}) AND archived_at IS NULL`)
              .all(...linkNoteIds) as { id: string; title: string; body_plain: string }[]
            entityLinkedNotes = rows.map((r) => ({
              id: r.id,
              title: r.title,
              excerpt: r.body_plain.length > 2000 ? r.body_plain.slice(0, 2000) + '…' : r.body_plain,
            }))
          }
        } catch {
          // non-critical
        }
      }
      // Flat EntityContext[] for Claude tool assignment — keep [id:...] working for action items / events
      const entityContext: EntityContext[] = richEntities.map((e) => ({ id: e.id, name: e.name, type_name: e.type_name }))

      // Fetch full content of notes linked to events / action items and append to context
      try {
        const existingIds = new Set(contextNotes.map((n) => n.id))
        const linkedIds = new Set<string>()
        for (const ev of calendarEvents) {
          if (ev.linked_note_id && !existingIds.has(ev.linked_note_id)) linkedIds.add(ev.linked_note_id)
        }
        for (const item of actionItems) {
          if (item.source_note_id && !existingIds.has(item.source_note_id)) linkedIds.add(item.source_note_id)
        }
        if (linkedIds.size > 0) {
          const ids = [...linkedIds].slice(0, 20)
          const placeholders = ids.map(() => '?').join(',')
          const rows = db
            .prepare(
              `SELECT id, title, body_plain FROM notes
               WHERE id IN (${placeholders}) AND archived_at IS NULL`,
            )
            .all(...ids) as { id: string; title: string; body_plain: string }[]
          for (const row of rows) {
            contextNotes.push({
              id: row.id,
              title: row.title,
              excerpt: row.body_plain.length > 800 ? row.body_plain.slice(0, 800) + '…' : row.body_plain,
            })
          }
        }
      } catch {
        // non-critical — skip linked note injection on error
      }

      let content: string
      let executedActions: ExecutedAction[] = []
      let entityRefs: { id: string; name: string }[] = []
      try {
        const result = await sendChatMessage(messages, contextNotes, calendarEvents, actionItems, images, chatModel, files, entityContext, pinnedNotes, richEntities, entityLinkedNotes)
        content = result.content
        executedActions = result.actions
        entityRefs = result.entityRefs
      } catch (err) {
        console.error('[Chat] Claude API error:', err)
        return {
          content: 'Something went wrong calling the Claude API. Please check your API key and try again.',
          references: [],
          actions: [],
          entityRefs: [],
        }
      }

      // Parse [Note: "Title"] citations and resolve to note IDs
      const noteRefRegex = /\[Note:\s*"([^"]+)"\]/g
      const references: { id: string; title: string }[] = []
      let match
      while ((match = noteRefRegex.exec(content)) !== null) {
        const title = match[1]
        const note = contextNotes.find((n) => n.title.toLowerCase() === title.toLowerCase())
        if (note && !references.find((r) => r.id === note.id)) {
          references.push({ id: note.id, title: note.title })
        }
      }

      // Collect any {{entity:uuid:Name}} refs from the response that sendChatMessage() didn't
      // already capture (e.g. because the entity wasn't in the original entity context).
      // ID is embedded directly — no DB lookup needed.
      const refsById = new Map(entityRefs.map((e) => [e.id, e]))
      for (const m of content.matchAll(new RegExp(ENTITY_TOKEN_RE.source, 'g'))) {
        const id   = m[1]
        const name = m[2].trim()
        if (id && !refsById.has(id)) refsById.set(id, { id, name })
      }
      entityRefs = Array.from(refsById.values())

      return { content, references, actions: executedActions, entityRefs }
    },
  )

  // ─── Calendar Events ──────────────────────────────────────────────────────────

  type CalendarEventRow = {
    id: number
    external_id: string | null
    source_id: string | null
    title: string
    start_at: string
    end_at: string
    attendees: string
    linked_note_id: string | null
    transcript_note_id: string | null
    recurrence_rule: string | null
    recurrence_series_id: number | null
    recurrence_instance_date: string | null
    synced_at: string
  }

  /** calendar-events:list — returns events in a date range, with linked note title. */
  ipcMain.handle(
    'calendar-events:list',
    (_event, { start_at, end_at }: { start_at: string; end_at: string }) => {
      const db = getDatabase()
      return db
        .prepare(
          `SELECT ce.*, n.title AS linked_note_title
           FROM calendar_events ce
           LEFT JOIN notes n ON ce.linked_note_id = n.id
           WHERE ce.start_at >= ? AND ce.start_at < ?
           ORDER BY ce.start_at ASC`,
        )
        .all(start_at, end_at) as (CalendarEventRow & { linked_note_title: string | null })[]
    },
  )

  /** calendar-events:create — creates a new calendar event. */
  ipcMain.handle(
    'calendar-events:create',
    (
      _event,
      opts: {
        title: string
        start_at: string
        end_at: string
        attendees?: Array<{ email: string; name: string }>
        linked_note_id?: string | null
        recurrence_rule?: string | null
      },
    ) => {
      const db = getDatabase()
      const result = db
        .prepare(
          `INSERT INTO calendar_events (title, start_at, end_at, attendees, linked_note_id, recurrence_rule)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          opts.title,
          opts.start_at,
          opts.end_at,
          JSON.stringify(opts.attendees ?? []),
          opts.linked_note_id ?? null,
          opts.recurrence_rule ?? null,
        )

      const newId = result.lastInsertRowid as number

      // Generate occurrence rows for the rolling window when the event recurs
      if (opts.recurrence_rule) {
        generateOccurrences(db, newId)
      }

      return db
        .prepare(
          `SELECT ce.*, n.title AS linked_note_title
           FROM calendar_events ce
           LEFT JOIN notes n ON ce.linked_note_id = n.id
           WHERE ce.id = ?`,
        )
        .get(newId) as CalendarEventRow & { linked_note_title: string | null }
    },
  )

  /** calendar-events:update — updates fields on an existing calendar event. */
  ipcMain.handle(
    'calendar-events:update',
    (
      _event,
      opts: {
        id: number
        title?: string
        start_at?: string
        end_at?: string
        attendees?: Array<{ email: string; name: string }>
        linked_note_id?: string | null
        transcript_note_id?: string | null
        recurrence_rule?: string | null
        /** How broadly to apply changes on recurring events. Defaults to 'this'. */
        update_scope?: UpdateScope
      },
    ) => {
      const db = getDatabase()
      const scope: UpdateScope = opts.update_scope ?? 'this'

      // Build the plain column→value map (same fields as before plus recurrence_rule)
      const changes: Record<string, unknown> = {}
      if (opts.title !== undefined) changes.title = opts.title
      if (opts.start_at !== undefined) changes.start_at = opts.start_at
      if (opts.end_at !== undefined) changes.end_at = opts.end_at
      if (opts.attendees !== undefined) changes.attendees = JSON.stringify(opts.attendees)
      if ('linked_note_id' in opts) changes.linked_note_id = opts.linked_note_id ?? null
      if ('transcript_note_id' in opts) changes.transcript_note_id = opts.transcript_note_id ?? null
      if ('recurrence_rule' in opts) changes.recurrence_rule = opts.recurrence_rule ?? null

      if (Object.keys(changes).length === 0) return { ok: true }

      // Check if this event belongs to a recurring series (or is a series root itself)
      const row = db
        .prepare('SELECT recurrence_series_id, recurrence_rule FROM calendar_events WHERE id = ?')
        .get(opts.id) as { recurrence_series_id: number | null; recurrence_rule: string | null } | undefined

      const isRecurring = row && (row.recurrence_series_id !== null || row.recurrence_rule !== null)

      if (isRecurring && (scope === 'future' || scope === 'all')) {
        // Delegate to the engine for multi-occurrence updates
        applyRecurrenceUpdate(db, opts.id, changes, scope)
      } else {
        // Plain single-row update (scope='this', or non-recurring event)
        const sets = Object.keys(changes).map((k) => `${k} = ?`)
        const params = [...Object.values(changes), opts.id]
        db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`)
          .run(...(params as (string | number | null)[]))

        // If recurrence_rule was just set on a non-occurrence row, generate occurrences
        if ('recurrence_rule' in opts && opts.recurrence_rule && !row?.recurrence_series_id) {
          generateOccurrences(db, opts.id)
        }
      }

      return { ok: true }
    },
  )

  /** calendar-events:delete — hard-deletes a calendar event. */
  ipcMain.handle(
    'calendar-events:delete',
    (_event, { id, delete_scope }: { id: number; delete_scope?: DeleteScope }) => {
      const db = getDatabase()

      if (delete_scope && delete_scope !== 'this') {
        applyRecurrenceDelete(db, id, delete_scope)
      } else {
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(id)
      }

      return { ok: true }
    },
  )

  /** calendar-events:get-series-notes — past occurrences of a recurring series with their linked notes. */
  ipcMain.handle(
    'calendar-events:get-series-notes',
    (_event, { series_id }: { series_id: number }) => {
      const db = getDatabase()
      return getSeriesNotes(db, series_id)
    },
  )

  /** calendar-events:get-by-note — returns the calendar event that has linked_note_id = note_id, or null. */
  ipcMain.handle('calendar-events:get-by-note', (_event, { note_id }: { note_id: string }) => {
    const db = getDatabase()
    return (db
      .prepare(
        `SELECT ce.*, n.title AS linked_note_title
         FROM calendar_events ce
         LEFT JOIN notes n ON ce.linked_note_id = n.id
         WHERE ce.linked_note_id = ?
         LIMIT 1`,
      )
      .get(note_id) as (CalendarEventRow & { linked_note_title: string | null }) | null)
  })

  /** transcriptions:list — all transcription sessions for a note, newest first. */
  ipcMain.handle('transcriptions:list', (_event, { noteId }: { noteId: string }) => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT id, note_id, started_at, ended_at, raw_transcript, summary
         FROM note_transcriptions WHERE note_id = ? ORDER BY started_at DESC`,
      )
      .all(noteId)
  })

  /** transcriptions:delete — hard-delete a single transcription session row. */
  ipcMain.handle('transcriptions:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    db.prepare('DELETE FROM note_transcriptions WHERE id = ?').run(id)
    return { ok: true }
  })

  // ─── Daily Briefs ─────────────────────────────────────────────────────────────

  type DailyBriefRow = {
    id: number
    date: string
    content: string
    calendar_snapshot: string
    pending_actions_snapshot: string
    generated_at: string
    acknowledged_at: string | null
  }

  /**
   * daily-briefs:get — returns the stored brief for a date (YYYY-MM-DD), or null.
   * Does NOT auto-generate — caller triggers generation explicitly.
   */
  ipcMain.handle('daily-briefs:get', (_event, { date }: { date: string }) => {
    const db = getDatabase()
    return (db.prepare('SELECT * FROM daily_briefs WHERE date = ?').get(date) as DailyBriefRow | undefined) ?? null
  })

  /**
   * daily-briefs:generate — (re)generates the daily brief for a date using Claude Sonnet.
   * Persists the result and returns the full row.
   * Returns { error } if no Anthropic API key is configured.
   */
  ipcMain.handle('daily-briefs:generate', async (_event, { date }: { date: string }) => {
    const db = getDatabase()

    const setting = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('anthropic_api_key') as { value: string } | undefined
    const apiKey = setting?.value ?? ''

    if (!apiKey) {
      return { error: 'No Anthropic API key configured. Open Settings → AI to add one.' }
    }

    // Gather snapshots at generation time (for provenance / future replay)
    const dayStart = `${date}T00:00:00`
    const dayEnd = `${date}T23:59:59`
    const calendarSnapshot = db
      .prepare(
        `SELECT id, title, start_at, end_at, attendees
         FROM calendar_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at`,
      )
      .all(dayStart, dayEnd)
    const actionsSnapshot = db
      .prepare(
        `SELECT id, title, status, due_date FROM action_items
         WHERE status IN ('open', 'in_progress') ORDER BY due_date ASC NULLS LAST`,
      )
      .all()

    const dailyBriefModelRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('model_daily_brief') as { value: string } | undefined
    const dailyBriefModel = dailyBriefModelRow?.value || 'claude-sonnet-4-6'

    const { generateDailyBrief } = await import('../embedding/dailyBrief')
    const content = await generateDailyBrief(date, apiKey, dailyBriefModel)
    const now = new Date().toISOString()

    db.prepare(
      `INSERT INTO daily_briefs (date, content, calendar_snapshot, pending_actions_snapshot, generated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         content                   = excluded.content,
         calendar_snapshot         = excluded.calendar_snapshot,
         pending_actions_snapshot  = excluded.pending_actions_snapshot,
         generated_at              = excluded.generated_at,
         acknowledged_at           = NULL`,
    ).run(date, content, JSON.stringify(calendarSnapshot), JSON.stringify(actionsSnapshot), now)

    return (db.prepare('SELECT * FROM daily_briefs WHERE date = ?').get(date) as DailyBriefRow | undefined) ?? null
  })

  /**
   * daily-briefs:acknowledge — marks a brief as read by setting acknowledged_at.
   */
  ipcMain.handle('daily-briefs:acknowledge', (_event, { date }: { date: string }) => {
    const db = getDatabase()
    db.prepare(`UPDATE daily_briefs SET acknowledged_at = ? WHERE date = ?`).run(
      new Date().toISOString(),
      date,
    )
    return { ok: true }
  })

  // ─── Calendar Sources ─────────────────────────────────────────────────────────

  /** calendar-sources:list — all configured sync sources. */
  ipcMain.handle('calendar-sources:list', () => {
    const db = getDatabase()
    return db.prepare('SELECT * FROM calendar_sources ORDER BY created_at ASC').all() as CalendarSource[]
  })

  /** calendar-sources:create — add a new sync source. */
  ipcMain.handle(
    'calendar-sources:create',
    (
      _event,
      opts: {
        provider_id: string
        name: string
        config: Record<string, string>
        sync_interval_minutes?: number
      },
    ) => {
      const db = getDatabase()
      const id = randomUUID()
      db.prepare(
        `INSERT INTO calendar_sources (id, provider_id, name, config, sync_interval_minutes)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        id,
        opts.provider_id,
        opts.name,
        JSON.stringify(opts.config),
        opts.sync_interval_minutes ?? 60,
      )
      return db.prepare('SELECT * FROM calendar_sources WHERE id = ?').get(id) as CalendarSource
    },
  )

  /** calendar-sources:update — partial update of name, config, enabled, or sync_interval_minutes. */
  ipcMain.handle(
    'calendar-sources:update',
    (
      _event,
      opts: {
        id: string
        name?: string
        config?: Record<string, string>
        enabled?: boolean
        sync_interval_minutes?: number
      },
    ) => {
      const db = getDatabase()
      const sets: string[] = []
      const vals: unknown[] = []

      if (opts.name !== undefined) { sets.push('name = ?'); vals.push(opts.name) }
      if (opts.config !== undefined) { sets.push('config = ?'); vals.push(JSON.stringify(opts.config)) }
      if (opts.enabled !== undefined) { sets.push('enabled = ?'); vals.push(opts.enabled ? 1 : 0) }
      if (opts.sync_interval_minutes !== undefined) { sets.push('sync_interval_minutes = ?'); vals.push(opts.sync_interval_minutes) }

      if (sets.length === 0) return { ok: true }

      vals.push(opts.id)
      db.prepare(`UPDATE calendar_sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
      return { ok: true }
    },
  )

  /** calendar-sources:delete — remove a source and all its synced events that have no linked note. */
  ipcMain.handle('calendar-sources:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()

    // Detach any synced events that have a linked note (user annotated them) so they
    // become standalone local events rather than disappearing entirely.
    db.prepare(
      `UPDATE calendar_events SET external_id = NULL, source_id = NULL
       WHERE source_id = ? AND linked_note_id IS NOT NULL`,
    ).run(id)

    // Hard-delete the remaining synced events for this source (no linked note).
    db.prepare('DELETE FROM calendar_events WHERE source_id = ?').run(id)

    // Delete the source itself.
    db.prepare('DELETE FROM calendar_sources WHERE id = ?').run(id)

    return { ok: true }
  })

  /** calendar-sources:verify — test provider connectivity without persisting anything. */
  ipcMain.handle(
    'calendar-sources:verify',
    async (
      _event,
      { provider_id, config }: { provider_id: string; config: Record<string, string> },
    ) => {
      const provider = getProvider(provider_id)
      if (!provider) {
        return { ok: false, error: `Unknown provider: ${provider_id}` }
      }
      return provider.verify(config)
    },
  )

  /** calendar-sources:sync-now — immediately sync one source, bypassing the interval check. */
  ipcMain.handle('calendar-sources:sync-now', async (_event, { id }: { id: string }) => {
    try {
      const count = await syncSourceNow(id)
      return { ok: true, count }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  })

  /** calendar-sources:get-script — returns the script source + instructions for the given provider.
   *  Relay provider returns secondSource (corp script) in addition to source (personal script). */
  ipcMain.handle('calendar-sources:get-script', (_e, args: { provider_id?: string } = {}) => {
    if (args.provider_id === 'jsonbin') {
      return { source: JSONBIN_SCRIPT_SOURCE, instructions: JSONBIN_INSTRUCTIONS }
    }
    if (args.provider_id === 'google_apps_script_relay') {
      return {
        source: RELAY_PERSONAL_SCRIPT_SOURCE,
        secondSource: RELAY_CORP_SCRIPT_SOURCE,
        instructions: RELAY_INSTRUCTIONS,
      }
    }
    return { source: APPS_SCRIPT_SOURCE, instructions: APPS_SCRIPT_INSTRUCTIONS }
  })
}
