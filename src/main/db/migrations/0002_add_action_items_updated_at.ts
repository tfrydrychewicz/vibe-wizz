import type { Migration } from './index'

export const migration: Migration = {
  version: 2,
  name: 'add_action_items_updated_at',
  up(db) {
    // SQLite does not support IF NOT EXISTS on ALTER TABLE.
    // try/catch makes this idempotent in case schema_migrations is ever manually reset.
    try {
      db.exec('ALTER TABLE action_items ADD COLUMN updated_at TEXT')
    } catch {
      // Column already exists — harmless, continue.
    }
  },
}
