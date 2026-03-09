import type { Migration } from './index'

/**
 * Adds matched_texts column to entity_mentions.
 * Stores the verbatim text fragments (JSON array) that the NER model
 * matched to an auto-detected entity — including declined forms,
 * partial names, and typo variants. Used by the editor decoration to
 * underline the actual text span rather than the canonical entity name.
 */
export const migration: Migration = {
  version: 14,
  name: 'entity_mention_matched_texts',
  up(db) {
    db.exec(`ALTER TABLE entity_mentions ADD COLUMN matched_texts TEXT`)
  },
}
