import type { Migration } from './index'

/**
 * Introduce external calendar sync support:
 *
 * 1. calendar_sources  — one row per configured external calendar integration
 *    (Google Apps Script URL, iCal URL, …).  Holds provider ID, user-given
 *    name, provider-specific config JSON, sync cadence, and last-sync timestamp.
 *
 * 2. calendar_events.source_id  — FK to calendar_sources.  NULL = locally
 *    created event (editable); non-NULL = synced event (read-only in the UI;
 *    linked_note_id and transcript_note_id are still user-editable and are
 *    preserved across re-syncs by the ON CONFLICT UPDATE clause in the engine).
 *
 * 3. Index on calendar_events.source_id  — makes source-scoped queries fast
 *    (e.g. "delete all stale events from source X").
 */
export const migration: Migration = {
  version: 5,
  name: 'calendar_sources',
  up(db) {
    // 1. New table — safe to run unconditionally (IF NOT EXISTS).
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_sources (
        id                    TEXT PRIMARY KEY,
        provider_id           TEXT NOT NULL,
        name                  TEXT NOT NULL,
        config                TEXT NOT NULL DEFAULT '{}',
        enabled               INTEGER NOT NULL DEFAULT 1,
        sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
        last_sync_at          TEXT,
        created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    `)

    // 2. New column on calendar_events — idempotent try/catch.
    try {
      db.exec(
        'ALTER TABLE calendar_events ADD COLUMN source_id TEXT REFERENCES calendar_sources(id) ON DELETE SET NULL'
      )
    } catch {
      // Column already exists — safe to continue.
    }

    // 3. Index for source-scoped queries.
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_calendar_events_source_id ON calendar_events(source_id)'
    )
  },
}
