import type { Migration } from './index'

export const migration: Migration = {
  version: 6,
  name: 'notes_embedding_dirty',
  up(db) {
    db.exec(
      `ALTER TABLE notes ADD COLUMN embedding_dirty INTEGER NOT NULL DEFAULT 0`
    )
  },
}
