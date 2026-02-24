import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA_SQL } from './schema'

let _db: Database.Database | null = null

export function initDatabase(): Database.Database {
  const isDev = process.env['NODE_ENV'] === 'development'
  const dbFile = isDev ? 'wizz.dev.db' : 'wizz.db'
  const dbPath = join(app.getPath('userData'), dbFile)

  _db = new Database(dbPath)

  // WAL mode: readers don't block writers, better concurrency for future use
  _db.pragma('journal_mode = WAL')
  // NORMAL sync is safe with WAL and much faster than FULL
  _db.pragma('synchronous = NORMAL')
  // 64 MB page cache
  _db.pragma('cache_size = -65536')
  // Enforce referential integrity
  _db.pragma('foreign_keys = ON')
  // Keep temp tables in memory
  _db.pragma('temp_store = MEMORY')

  _db.exec(SCHEMA_SQL)

  // Migration: add trashed_at to entities (idempotent — ALTER TABLE fails silently if column exists)
  try { _db.exec('ALTER TABLE entities ADD COLUMN trashed_at TEXT') } catch { /* already exists */ }

  console.log(`[DB] Initialized: ${dbPath}`)
  return _db
}

export function getDatabase(): Database.Database {
  if (!_db) throw new Error('Database not initialized. Call initDatabase() first.')
  return _db
}

export function closeDatabase(): void {
  if (_db) {
    _db.close()
    _db = null
    console.log('[DB] Closed.')
  }
}
