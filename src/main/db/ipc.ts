import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { getDatabase, isVecLoaded } from './index'
import { scheduleEmbedding } from '../embedding/pipeline'
import { setOpenAIKey, embedTexts } from '../embedding/embedder'

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

  /** notes:delete — soft-deletes a note by setting archived_at. */
  ipcMain.handle('notes:delete', (_event, { id }: { id: string }) => {
    const db = getDatabase()
    db.prepare(
      `UPDATE notes SET archived_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`
    ).run(id)
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

      // Sync entity_mentions: rebuild from current body
      const mentionIds = extractMentionIds(body)
      db.prepare(`DELETE FROM entity_mentions WHERE note_id = ?`).run(id)
      const insertMention = db.prepare(
        `INSERT OR IGNORE INTO entity_mentions (note_id, entity_id) VALUES (?, ?)`
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

  // ─── Entities ────────────────────────────────────────────────────────────────

  /**
   * entities:search — searches non-trashed entities by name across all types.
   * Used by the @mention suggestion in the note editor.
   */
  ipcMain.handle('entities:search', (_event, { query }: { query: string }) => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT e.id, e.name, e.type_id, et.name AS type_name, et.icon AS type_icon
         FROM entities e
         JOIN entity_types et ON e.type_id = et.id
         WHERE e.name LIKE ? COLLATE NOCASE
           AND e.trashed_at IS NULL
         ORDER BY e.name COLLATE NOCASE
         LIMIT 20`
      )
      .all(`%${query}%`)
  })

  /** entities:list — returns all non-trashed entities of a given type, sorted by name. */
  ipcMain.handle('entities:list', (_event, { type_id }: { type_id: string }) => {
    const db = getDatabase()
    return db
      .prepare(
        `SELECT id, name, type_id, updated_at, created_at
         FROM entities WHERE type_id = ? AND trashed_at IS NULL ORDER BY name COLLATE NOCASE`
      )
      .all(type_id) as Pick<EntityRow, 'id' | 'name' | 'type_id' | 'updated_at' | 'created_at'>[]
  })

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
   * notes:semantic-search — hybrid FTS5 + vector search with Reciprocal Rank Fusion.
   *
   * Flow (when sqlite-vec loaded + OpenAI key configured):
   *   1. Run FTS5 keyword search (top 20) and KNN vector search (top 20) in parallel
   *   2. Merge via RRF: score = Σ 1/(60 + rank) across both lists
   *   3. Sort by combined score, return top 15 with best-matching chunk as excerpt
   *
   * Fallback (no vec / no API key / error): FTS5-only, up to 15 results, no excerpt.
   *
   * Input:  { query: string }
   * Output: { id, title, excerpt: string | null }[]  (up to 15 notes)
   */
  ipcMain.handle(
    'notes:semantic-search',
    async (_event, { query }: { query: string }): Promise<{ id: string; title: string; excerpt: string | null }[]> => {
      const db = getDatabase()

      // Sanitize query for FTS5 — strip operators/special chars that cause parse errors
      const ftsQuery = query
        .replace(/["\(\)\^\*\+\-]/g, ' ')
        .replace(/\b(AND|OR|NOT)\b/g, ' ')
        .trim()
        .replace(/\s+/g, ' ')

      const runFts = (limit: number): { id: string; title: string }[] => {
        if (!ftsQuery) return []
        try {
          return db
            .prepare(
              `SELECT n.id, n.title
               FROM notes_fts
               JOIN notes n ON n.rowid = notes_fts.rowid
               WHERE notes_fts MATCH ? AND n.archived_at IS NULL
               ORDER BY rank LIMIT ${limit}`
            )
            .all(ftsQuery) as { id: string; title: string }[]
        } catch {
          return []
        }
      }

      if (isVecLoaded()) {
        const setting = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('openai_api_key') as { value: string } | undefined
        const apiKey = setting?.value ?? ''

        if (apiKey) {
          try {
            setOpenAIKey(apiKey)
            const [embed] = await embedTexts([query])
            const queryBuf = Buffer.from(embed.embedding.buffer)

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

            const ftsHits = runFts(20)

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

            return [...candidates.values()]
              .sort((a, b) => b.score - a.score)
              .slice(0, 15)
              .map(({ id, title, excerpt }) => ({ id, title, excerpt }))
          } catch (err) {
            console.error('[Search] Hybrid search error — falling back to FTS:', err)
          }
        }
      }

      // FTS-only fallback (no vec / no API key / error above)
      return runFts(15).map((r) => ({ ...r, excerpt: null }))
    }
  )
}
