import type { Migration } from './index'

/**
 * Adds automated recurring review configuration to entity_types and creates
 * the entity_reviews table to store generated AI summaries per entity.
 *
 * entity_types additions:
 *   review_enabled   — master switch (default off)
 *   review_frequency — 'daily'|'weekly'|'biweekly'|'monthly'
 *   review_day       — day of week for weekly/biweekly ('mon'…'sun')
 *   review_time      — local HH:MM time to generate (default '07:00')
 *
 * entity_reviews:
 *   One row per generated review; FK ON DELETE CASCADE so reviews are
 *   automatically removed when the entity is hard-deleted.
 */
export const migration: Migration = {
  version: 10,
  name: 'entity_reviews',
  up(db) {
    db.exec(`
      ALTER TABLE entity_types ADD COLUMN review_enabled   INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE entity_types ADD COLUMN review_frequency TEXT;
      ALTER TABLE entity_types ADD COLUMN review_day       TEXT;
      ALTER TABLE entity_types ADD COLUMN review_time      TEXT NOT NULL DEFAULT '07:00';

      CREATE TABLE IF NOT EXISTS entity_reviews (
        id              TEXT PRIMARY KEY,
        entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
        period_start    TEXT NOT NULL,   -- ISO date YYYY-MM-DD
        period_end      TEXT NOT NULL,   -- ISO date YYYY-MM-DD
        content         TEXT NOT NULL,   -- Markdown review body
        generated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        model_id        TEXT,            -- model used (for reference/debugging)
        acknowledged_at TEXT             -- set when user first expands/views this review
      );

      CREATE INDEX IF NOT EXISTS idx_entity_reviews_entity
        ON entity_reviews(entity_id, generated_at DESC);
    `)
  },
}
