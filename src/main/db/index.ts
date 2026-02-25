import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA_SQL } from './schema'
import * as sqliteVec from 'sqlite-vec'

let _db: Database.Database | null = null
let _vecLoaded = false

export function isVecLoaded(): boolean {
  return _vecLoaded
}

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
  // Migration: add updated_at to action_items (idempotent)
  try { _db.exec('ALTER TABLE action_items ADD COLUMN updated_at TEXT') } catch { /* already exists */ }

  // Load sqlite-vec extension (graceful — app works without it, semantic search is just disabled)
  _vecLoaded = loadSqliteVec(_db)
  if (_vecLoaded) {
    initVecTables(_db)
    console.log('[DB] sqlite-vec loaded — semantic search enabled')
  }

  console.log(`[DB] Initialized: ${dbPath}`)
  return _db
}

/**
 * Loads the sqlite-vec extension into the database.
 * The extension ships as a platform-specific .dylib/.so/.dll binary.
 * In dev mode, sqlite-vec resolves its own path via __dirname.
 * In packaged mode, both sqlite-vec and the platform package are in app.asar.unpacked
 * so __dirname resolves to the real filesystem path — sqliteVec.load() works the same way.
 */
function loadSqliteVec(db: Database.Database): boolean {
  try {
    sqliteVec.load(db)
    return true
  } catch (err) {
    console.warn('[DB] sqlite-vec failed to load — semantic search disabled:', err)
    return false
  }
}

/**
 * Creates vec0 virtual tables for semantic search.
 * Must be called AFTER the extension is loaded (vec0 is not a built-in SQLite table type).
 * vec0 does not support IF NOT EXISTS, so we guard with a sqlite_master check.
 */
function initVecTables(db: Database.Database): void {
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_embeddings'")
    .get()
  if (exists) return

  db.exec(`
    CREATE VIRTUAL TABLE chunk_embeddings USING vec0(
      embedding FLOAT[1536] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE summary_embeddings USING vec0(
      embedding FLOAT[1536] distance_metric=cosine
    );
    CREATE VIRTUAL TABLE cluster_embeddings USING vec0(
      embedding FLOAT[1536] distance_metric=cosine
    );
  `)
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
