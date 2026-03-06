import type { Migration } from './index'

/**
 * Adds is_next_action boolean column to action_items.
 * Used to mark tasks as "Next Actions" (To Do tab) vs unprocessed (Inbox tab).
 */
export const migration: Migration = {
  version: 9,
  name: 'action_items_next_action',
  up(db) {
    db.exec(`ALTER TABLE action_items ADD COLUMN is_next_action INTEGER NOT NULL DEFAULT 0`)
  },
}
