import Database from 'better-sqlite3'
import { migration as m0001 } from './0001_add_entities_trashed_at'
import { migration as m0002 } from './0002_add_action_items_updated_at'
import { migration as m0003 } from './0003_team_computed_members'

export interface Migration {
  /** Integer matching the 4-digit file prefix, e.g. file 0003_... → version 3 */
  version: number
  /** Human-readable label matching the filename suffix */
  name: string
  up: (db: Database.Database) => void
}

/**
 * All migrations in ascending version order.
 * To add a new migration:
 *   1. Create src/main/db/migrations/NNNN_description.ts
 *   2. Import it here and append to this array
 *   3. If adding a new table, also add CREATE TABLE IF NOT EXISTS to schema.ts
 *      If adding a column to an existing table, migration file only (do NOT touch schema.ts)
 */
const ALL_MIGRATIONS: Migration[] = [m0001, m0002, m0003]

/**
 * Run all pending migrations synchronously. Call once inside initDatabase(),
 * after SCHEMA_SQL has been applied and before sqlite-vec is loaded.
 *
 * Handles three cases:
 *   - Fresh install:   schema_migrations empty, no trashed_at → run 0001, 0002 normally
 *   - Existing user DB (first run after upgrade): schema_migrations empty, trashed_at present
 *                       → stamp 0001 and 0002 as applied without re-running
 *   - Subsequent runs: schema_migrations has rows → skip already-applied, run any new ones
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)

  // Bootstrap detection: if schema_migrations is empty AND the canary column
  // entities.trashed_at already exists, this DB predates the migration system.
  // Stamp all known migrations as applied (they were run as inline try/catch blocks).
  const rowCount = (
    db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }
  ).c

  if (rowCount === 0) {
    const cols = db.pragma('table_info(entities)') as { name: string }[]
    const isExistingDb = cols.some(c => c.name === 'trashed_at')
    if (isExistingDb) {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)'
      )
      db.transaction(() => {
        for (const m of ALL_MIGRATIONS) insert.run(m.version, m.name)
      })()
      console.log('[DB] Stamped existing DB migrations (bootstrap).')
      return
    }
  }

  // Normal path: apply any pending migrations in order
  const applied = new Set(
    (
      db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
    ).map(r => r.version)
  )

  for (const migration of ALL_MIGRATIONS) {
    if (applied.has(migration.version)) continue
    console.log(`[DB] Applying migration ${migration.version}: ${migration.name}`)
    db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(
        migration.version,
        migration.name
      )
    })()
    console.log(`[DB] Migration ${migration.version} done.`)
  }
}
