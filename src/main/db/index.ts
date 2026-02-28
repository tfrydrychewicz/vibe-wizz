import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { SCHEMA_SQL } from './schema'
import { runMigrations } from './migrations/index'
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

  runMigrations(_db)

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
 *
 * In dev, sqlite-vec resolves its own path via __dirname which points to the real
 * node_modules directory — no remapping needed.
 *
 * In a packaged Electron app, sqlite-vec's __dirname resolves to the VIRTUAL ASAR path
 * (app.asar/node_modules/sqlite-vec/) even though the file is physically in
 * app.asar.unpacked. Electron patches fs.statSync so the existence check inside
 * getLoadablePath() passes, but native dlopen() bypasses Electron's ASAR intercept and
 * sees app.asar as a regular file (ENOTDIR). We must remap to the real unpacked path.
 */
function loadSqliteVec(db: Database.Database): boolean {
  try {
    const rawPath = sqliteVec.getLoadablePath()
    // Remap virtual ASAR path → real unpacked path so dlopen() gets a real filesystem path.
    // In dev rawPath contains no 'app.asar' segment, so this replace is a no-op.
    const loadablePath = rawPath.replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    db.loadExtension(loadablePath)
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
