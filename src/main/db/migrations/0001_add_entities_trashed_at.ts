import type { Migration } from './index'

export const migration: Migration = {
  version: 1,
  name: 'add_entities_trashed_at',
  up(db) {
    // SQLite does not support IF NOT EXISTS on ALTER TABLE.
    // try/catch makes this idempotent in case schema_migrations is ever manually reset.
    try {
      db.exec('ALTER TABLE entities ADD COLUMN trashed_at TEXT')
    } catch {
      // Column already exists — harmless, continue.
    }
  },
}
