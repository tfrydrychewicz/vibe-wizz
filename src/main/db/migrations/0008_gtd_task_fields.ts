import type { Migration } from './index'

/**
 * GTD task fields — adds project linking, sub-tasks, contexts, energy level,
 * and "waiting for" tracking to action_items. Also extends the status CHECK
 * constraint to include 'someday' (requires table recreation in SQLite).
 *
 * New columns:
 *   parent_id            — self-referencing FK for sub-tasks
 *   project_entity_id    — FK to entities (the GTD project this task belongs to)
 *   contexts             — JSON string array, e.g. '["@computer","@office"]'
 *   energy_level         — 'low' | 'medium' | 'high' | NULL
 *   is_waiting_for       — 0/1 boolean
 *   waiting_for_entity_id — FK to entities (who we're waiting on)
 *
 * Status constraint updated to include 'someday'.
 */
export const migration: Migration = {
  version: 8,
  name: 'gtd_task_fields',
  up(db) {
    // ── 1. Recreate action_items with updated CHECK + new columns ─────────────
    // SQLite does not support ALTER TABLE to modify CHECK constraints, so we
    // use the recommended rename → create → copy → drop → rename pattern.

    db.exec(`
      CREATE TABLE action_items_new (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        body                 TEXT,
        source_note_id       TEXT REFERENCES notes(id) ON DELETE SET NULL,
        assigned_entity_id   TEXT REFERENCES entities(id) ON DELETE SET NULL,
        parent_id            TEXT REFERENCES action_items_new(id) ON DELETE SET NULL,
        project_entity_id    TEXT REFERENCES entities(id) ON DELETE SET NULL,
        contexts             TEXT NOT NULL DEFAULT '[]',
        energy_level         TEXT CHECK(energy_level IN ('low','medium','high') OR energy_level IS NULL),
        is_waiting_for       INTEGER NOT NULL DEFAULT 0,
        waiting_for_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
        due_date             TEXT,
        status               TEXT NOT NULL DEFAULT 'open'
                             CHECK(status IN ('open','in_progress','done','cancelled','someday')),
        extraction_type      TEXT NOT NULL DEFAULT 'manual'
                             CHECK(extraction_type IN ('manual','ai_extracted')),
        confidence           REAL NOT NULL DEFAULT 1.0,
        created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at           TEXT,
        completed_at         TEXT
      )
    `)

    // Copy existing data — new columns get their defaults
    db.exec(`
      INSERT INTO action_items_new
        (id, title, body, source_note_id, assigned_entity_id, due_date, status,
         extraction_type, confidence, created_at, updated_at, completed_at)
      SELECT
        id, title, body, source_note_id, assigned_entity_id, due_date, status,
        extraction_type, confidence, created_at, updated_at, completed_at
      FROM action_items
    `)

    db.exec(`DROP TABLE action_items`)
    db.exec(`ALTER TABLE action_items_new RENAME TO action_items`)

    // ── 2. Recreate indexes ───────────────────────────────────────────────────
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_action_items_status      ON action_items(status);
      CREATE INDEX IF NOT EXISTS idx_action_items_source_note ON action_items(source_note_id);
      CREATE INDEX IF NOT EXISTS idx_action_items_assigned    ON action_items(assigned_entity_id);
      CREATE INDEX IF NOT EXISTS idx_action_items_parent      ON action_items(parent_id);
      CREATE INDEX IF NOT EXISTS idx_action_items_project     ON action_items(project_entity_id);
      CREATE INDEX IF NOT EXISTS idx_action_items_waiting     ON action_items(is_waiting_for);
    `)
  },
}
