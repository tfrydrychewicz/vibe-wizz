import type { Migration } from './index'

/**
 * Seeds the `image_generation` feature slot into ai_feature_models
 * for users who already have an image-capable model enabled.
 *
 * Finds the first enabled image model (gpt-image-1, imagen-*, gemini-*-image-*)
 * and creates a chain entry at position 0 for the image_generation slot.
 * No-op if no image models are enabled.
 */
export const migration: Migration = {
  version: 13,
  name: 'image_generation_slot',
  up(db) {
    const imageModel = db
      .prepare(
        `SELECT m.id AS model_id
         FROM ai_models m
         JOIN ai_providers p ON p.id = m.provider_id
         WHERE m.enabled = 1
           AND p.enabled = 1
           AND p.api_key != ''
           AND m.capabilities LIKE '%image%'
         ORDER BY m.id ASC
         LIMIT 1`,
      )
      .get() as { model_id: string } | undefined

    if (imageModel) {
      db.prepare(
        `INSERT OR IGNORE INTO ai_feature_models (feature_slot, position, model_id)
         VALUES ('image_generation', 0, ?)`,
      ).run(imageModel.model_id)
    }
  },
}
