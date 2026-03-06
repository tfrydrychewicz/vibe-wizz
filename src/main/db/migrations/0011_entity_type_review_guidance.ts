import type { Migration } from './index'

/**
 * Adds a free-text review_guidance column to entity_types.
 *
 * This replaces the hardcoded per-type guidance strings in reviewGenerator.ts.
 * Users can now write (or AI-generate) custom instructions that tell the model
 * what to focus on when reviewing entities of this type.
 */
export const migration: Migration = {
  version: 11,
  name: 'entity_type_review_guidance',
  up(db) {
    db.exec(`
      ALTER TABLE entity_types ADD COLUMN review_guidance TEXT;
    `)
  },
}
