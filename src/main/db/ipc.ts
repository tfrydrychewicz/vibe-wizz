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

  /** notes:create — inserts a new empty note and returns the full row. */
  ipcMain.handle('notes:create', () => {
    const db = getDatabase()
    const id = randomUUID()
    db.prepare(
      `INSERT INTO notes (id, title, body, body_plain) VALUES (?, ?, ?, ?)`
    ).run(id, 'Untitled', '{}', '')
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

  /**
   * notes:update — updates title, body, body_plain, and updated_at for a note.
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
      return { ok: true }
    }
  )
}
