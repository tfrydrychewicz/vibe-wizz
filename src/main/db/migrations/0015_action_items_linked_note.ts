import type { Migration } from './index'

/**
 * Adds linked_note_id column to action_items.
 * User-attached note for task context (distinct from source_note_id which is
 * where the task was extracted from). Rendered in Actions view and TaskDetailPanel.
 */
export const migration: Migration = {
  version: 15,
  name: 'action_items_linked_note',
  up(db) {
    db.exec(`ALTER TABLE action_items ADD COLUMN linked_note_id TEXT REFERENCES notes(id) ON DELETE SET NULL`)
  },
}
