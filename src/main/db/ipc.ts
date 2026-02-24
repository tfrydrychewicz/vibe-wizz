import { ipcMain } from 'electron'
import { randomUUID } from 'crypto'
import { getDatabase } from './index'

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

  /** notes:create — inserts a new note and returns the full row. Accepts optional title. */
  ipcMain.handle('notes:create', (_event, opts?: { title?: string }) => {
    const db = getDatabase()
    const id = randomUUID()
    const title = opts?.title ?? 'Untitled'
    db.prepare(
      `INSERT INTO notes (id, title, body, body_plain) VALUES (?, ?, ?, ?)`
    ).run(id, title, '{}', '')
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

  /** notes:delete-forever — hard-deletes a note permanently. */
  ipcMain.handle('notes:delete-forever', (_event, { id }: { id: string }) => {
    const db = getDatabase()
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
}
