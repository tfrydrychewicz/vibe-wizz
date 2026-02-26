import type { Migration } from './index'

/**
 * Add recurring-meeting columns to calendar_events:
 *
 * recurrence_series_id      — FK to the series-root event (the event whose
 *                             recurrence_rule is set). NULL on the root itself
 *                             and on plain non-recurring events.
 *
 * recurrence_instance_date  — ISO date (YYYY-MM-DD) of the specific slot this
 *                             occurrence fills. NULL on the root and on plain
 *                             events; set on every generated occurrence row.
 *
 * An index on recurrence_series_id makes series-member look-ups fast.
 */
export const migration: Migration = {
  version: 4,
  name: 'recurring_meetings',
  up(db) {
    try {
      db.exec('ALTER TABLE calendar_events ADD COLUMN recurrence_series_id TEXT')
    } catch {
      // Column already exists — idempotent, continue.
    }

    try {
      db.exec('ALTER TABLE calendar_events ADD COLUMN recurrence_instance_date TEXT')
    } catch {
      // Column already exists — idempotent, continue.
    }

    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events(recurrence_series_id)',
    )
  },
}
