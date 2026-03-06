import type { Migration } from './index'

/**
 * Adds review_filters TEXT column to entity_types.
 *
 * Stores a JSON array of filter rules that the scheduler applies when
 * selecting which entities to generate a review for.
 *
 * Schema: Array<{ field: string; op: ReviewFilterOp; value: string }>
 * where ReviewFilterOp = 'eq' | 'neq' | 'contains' | 'not_contains' | 'is_set' | 'is_empty'
 *
 * All filters are ANDed. An empty or null array means all entities qualify.
 */
export const migration: Migration = {
  version: 12,
  name: 'entity_type_review_filters',
  up(db) {
    db.exec(`
      ALTER TABLE entity_types ADD COLUMN review_filters TEXT;
    `)
  },
}
