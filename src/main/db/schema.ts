/**
 * SQLite schema: all tables, FTS5 virtual table, sync triggers, and indexes.
 * Matches the data model defined in DESIGN.md.
 *
 * Execution order matters — tables referenced by FK must be created first.
 * Using CREATE TABLE IF NOT EXISTS so this is safe to run on every startup.
 */
export const SCHEMA_SQL = `

-- ─────────────────────────────────────────────
-- Note templates (referenced by notes.template_id)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_templates (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon        TEXT NOT NULL DEFAULT '📄',
  body        TEXT NOT NULL DEFAULT '{}',          -- TipTap JSON
  entity_type_id         TEXT,                     -- pre-linked entity type
  auto_create_trigger    TEXT,                     -- e.g. "1:1" calendar match
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Entity types (built-in + user-defined)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_types (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  icon                 TEXT NOT NULL DEFAULT 'tag',
  schema               TEXT NOT NULL DEFAULT '{}', -- JSON field definitions
  kanban_enabled       INTEGER NOT NULL DEFAULT 0,
  kanban_status_field  TEXT,
  color                TEXT,
  review_enabled       INTEGER NOT NULL DEFAULT 0,
  review_frequency     TEXT,                       -- 'daily'|'weekly'|'biweekly'|'monthly'
  review_day           TEXT,                       -- 'mon'…'sun' (weekly/biweekly only)
  review_time          TEXT NOT NULL DEFAULT '07:00', -- local HH:MM for scheduler window
  review_guidance      TEXT                        -- custom AI focus instructions for this type
);

INSERT OR IGNORE INTO entity_types (id, name, icon, schema, kanban_enabled, color) VALUES
  ('person', 'Person', 'user',
   '{"fields":[{"name":"role","type":"text"},{"name":"team","type":"entity_ref","entity_type":"team"},{"name":"email","type":"email"},{"name":"manager","type":"entity_ref","entity_type":"person"},{"name":"reports_to","type":"entity_ref","entity_type":"person"}]}',
   0, '#5b8def'),
  ('project', 'Project', 'folder',
   '{"fields":[{"name":"status","type":"select","options":["active","paused","done"]},{"name":"lead","type":"entity_ref","entity_type":"person"},{"name":"team","type":"entity_ref","entity_type":"team"},{"name":"priority","type":"select","options":["low","medium","high","critical"]}]}',
   1, '#f0a050'),
  ('team', 'Team', 'users',
   '{"fields":[{"name":"lead","type":"entity_ref","entity_type":"person"},{"name":"members","type":"computed","query":"SELECT p FROM Person WHERE p.team = {this}"}]}',
   0, '#50c0a0'),
  ('decision', 'Decision', 'scale',
   '{"fields":[{"name":"date","type":"date"},{"name":"context_note","type":"note_ref"},{"name":"status","type":"select","options":["proposed","accepted","rejected","superseded"]},{"name":"owner","type":"entity_ref","entity_type":"person"}]}',
   0, '#c070f0'),
  ('okr', 'OKR', 'target',
   '{"fields":[{"name":"quarter","type":"text"},{"name":"owner","type":"entity_ref","entity_type":"person"},{"name":"key_results","type":"text_list"},{"name":"status","type":"select","options":["on_track","at_risk","off_track","done"]}]}',
   1, '#f06070');

-- Migrate existing emoji icons to Lucide names (idempotent — only updates rows still holding the old emoji)
UPDATE entity_types SET icon = 'user'   WHERE id = 'person'   AND icon = '👤';
UPDATE entity_types SET icon = 'folder' WHERE id = 'project'  AND icon = '📁';
UPDATE entity_types SET icon = 'users'  WHERE id = 'team'     AND icon = '👥';
UPDATE entity_types SET icon = 'scale'  WHERE id = 'decision' AND icon = '⚖️';
UPDATE entity_types SET icon = 'target' WHERE id = 'okr'      AND icon = '🎯';

-- ─────────────────────────────────────────────
-- Notes
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notes (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'Untitled',
  body        TEXT NOT NULL DEFAULT '{}',          -- TipTap JSON document
  body_plain  TEXT NOT NULL DEFAULT '',            -- plain text for FTS
  template_id TEXT REFERENCES note_templates(id) ON DELETE SET NULL,
  source      TEXT NOT NULL DEFAULT 'manual'
              CHECK(source IN ('manual','transcript','daily_brief','import')),
  language    TEXT NOT NULL DEFAULT 'en',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  archived_at     TEXT,
  embedding_dirty INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────
-- Note chunks (used for embeddings in Phase 2)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id       TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_text    TEXT NOT NULL,
  chunk_context TEXT NOT NULL DEFAULT '',          -- contextual prefix for retrieval
  layer         INTEGER NOT NULL DEFAULT 1
                CHECK(layer IN (1,2,3)),            -- 1=raw 2=summary 3=cluster
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Entities
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type_id    TEXT NOT NULL REFERENCES entity_types(id),
  fields     TEXT NOT NULL DEFAULT '{}',           -- JSON dynamic fields
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Entity mentions within notes
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entity_mentions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id             TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  entity_id           TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  mention_type        TEXT NOT NULL DEFAULT 'manual'
                      CHECK(mention_type IN ('manual','auto_detected')),
  confidence          REAL NOT NULL DEFAULT 1.0,
  char_offset_start   INTEGER,
  char_offset_end     INTEGER,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Note relations (graph edges between notes)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_relations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  source_note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_note_id   TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  relation_type    TEXT NOT NULL
                   CHECK(relation_type IN ('references','follows_up','contradicts','supersedes')),
  strength         REAL NOT NULL DEFAULT 1.0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Action items
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS action_items (
  id                    TEXT PRIMARY KEY,
  title                 TEXT NOT NULL,
  body                  TEXT,
  source_note_id        TEXT REFERENCES notes(id) ON DELETE SET NULL,
  assigned_entity_id    TEXT REFERENCES entities(id) ON DELETE SET NULL,
  parent_id             TEXT REFERENCES action_items(id) ON DELETE SET NULL,
  project_entity_id     TEXT REFERENCES entities(id) ON DELETE SET NULL,
  contexts              TEXT NOT NULL DEFAULT '[]',
  energy_level          TEXT CHECK(energy_level IN ('low','medium','high') OR energy_level IS NULL),
  is_waiting_for        INTEGER NOT NULL DEFAULT 0,
  is_next_action        INTEGER NOT NULL DEFAULT 0,
  waiting_for_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL,
  due_date              TEXT,
  status                TEXT NOT NULL DEFAULT 'open'
                        CHECK(status IN ('open','in_progress','done','cancelled','someday')),
  extraction_type       TEXT NOT NULL DEFAULT 'manual'
                        CHECK(extraction_type IN ('manual','ai_extracted')),
  confidence            REAL NOT NULL DEFAULT 1.0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT,
  completed_at          TEXT
);

-- ─────────────────────────────────────────────
-- Calendar sources (external calendar integrations)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_sources (
  id                    TEXT PRIMARY KEY,
  provider_id           TEXT NOT NULL,              -- 'google_apps_script' | 'ical' | ...
  name                  TEXT NOT NULL,              -- user-given label
  config                TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific fields
  enabled               INTEGER NOT NULL DEFAULT 1,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_sync_at          TEXT,                       -- ISO 8601 of last successful sync
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Calendar events
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS calendar_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id          TEXT UNIQUE,
  title                TEXT NOT NULL,
  start_at             TEXT NOT NULL,
  end_at               TEXT NOT NULL,
  attendees            TEXT NOT NULL DEFAULT '[]', -- JSON array of {email, name}
  linked_note_id       TEXT REFERENCES notes(id) ON DELETE SET NULL,
  transcript_note_id   TEXT REFERENCES notes(id) ON DELETE SET NULL,
  recurrence_rule      TEXT,
  source_id            TEXT REFERENCES calendar_sources(id) ON DELETE SET NULL,
  synced_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ─────────────────────────────────────────────
-- Transcription sessions (one row per start/stop cycle)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS note_transcriptions (
  id              TEXT PRIMARY KEY,
  note_id         TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  raw_transcript  TEXT NOT NULL DEFAULT '',
  summary         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_note_transcriptions_note ON note_transcriptions(note_id);

-- ─────────────────────────────────────────────
-- Daily briefs
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_briefs (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  date                      TEXT NOT NULL UNIQUE,  -- ISO date YYYY-MM-DD
  content                   TEXT NOT NULL DEFAULT '',
  calendar_snapshot         TEXT NOT NULL DEFAULT '{}',
  pending_actions_snapshot  TEXT NOT NULL DEFAULT '{}',
  generated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  acknowledged_at           TEXT
);

-- ─────────────────────────────────────────────
-- FTS5 virtual table (external content from notes)
-- Searches title + body_plain without duplicating storage.
-- Rows are identified by notes.rowid (SQLite implicit integer key).
-- ─────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title,
  body_plain,
  content='notes',
  content_rowid='rowid',
  tokenize='unicode61'
);

-- Keep FTS5 in sync with the notes table via triggers
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body_plain)
  VALUES (new.rowid, new.title, new.body_plain);
END;

CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_plain)
  VALUES ('delete', old.rowid, old.title, old.body_plain);
END;

CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body_plain)
  VALUES ('delete', old.rowid, old.title, old.body_plain);
  INSERT INTO notes_fts(rowid, title, body_plain)
  VALUES (new.rowid, new.title, new.body_plain);
END;

-- ─────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_notes_updated_at         ON notes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_source             ON notes(source);
CREATE INDEX IF NOT EXISTS idx_notes_archived_at        ON notes(archived_at);

CREATE INDEX IF NOT EXISTS idx_entities_type_id         ON entities(type_id);
CREATE INDEX IF NOT EXISTS idx_entities_name            ON entities(name COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_entity_mentions_note     ON entity_mentions(note_id);
CREATE INDEX IF NOT EXISTS idx_entity_mentions_entity   ON entity_mentions(entity_id);

CREATE INDEX IF NOT EXISTS idx_note_chunks_note         ON note_chunks(note_id);

CREATE INDEX IF NOT EXISTS idx_note_relations_source    ON note_relations(source_note_id);
CREATE INDEX IF NOT EXISTS idx_note_relations_target    ON note_relations(target_note_id);

CREATE INDEX IF NOT EXISTS idx_action_items_status      ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_items_source_note ON action_items(source_note_id);
CREATE INDEX IF NOT EXISTS idx_action_items_assigned    ON action_items(assigned_entity_id);
-- idx_action_items_parent, idx_action_items_project, idx_action_items_waiting are created by
-- migration 0008 (after the GTD columns are added to existing DBs).

CREATE INDEX IF NOT EXISTS idx_calendar_events_start ON calendar_events(start_at);
-- idx_calendar_events_source_id is created by migration 0005 after source_id is added to existing DBs

-- ─────────────────────────────────────────────
-- Settings (key/value store for user preferences, e.g. API keys)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- ─────────────────────────────────────────────
-- AI provider & model configuration
-- ─────────────────────────────────────────────

-- One row per registered AI vendor (Anthropic, OpenAI, Google Gemini, …)
CREATE TABLE IF NOT EXISTS ai_providers (
  id        TEXT PRIMARY KEY,          -- e.g. 'anthropic', 'openai', 'gemini'
  api_key   TEXT NOT NULL DEFAULT '',
  enabled   INTEGER NOT NULL DEFAULT 1 -- 0 = disabled (key removed but rows preserved)
);

-- Models the user has selected/enabled per provider
CREATE TABLE IF NOT EXISTS ai_models (
  id           TEXT PRIMARY KEY,        -- provider model ID, e.g. 'claude-sonnet-4-6'
  provider_id  TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,           -- human-readable, e.g. 'Claude Sonnet 4.6'
  capabilities TEXT NOT NULL DEFAULT '["chat"]', -- JSON array: ['chat'] | ['embedding'] | ['chat','embedding']
  enabled      INTEGER NOT NULL DEFAULT 1
);

-- Per-feature ordered fallback chain (position 0 = primary model)
CREATE TABLE IF NOT EXISTS ai_feature_models (
  feature_slot TEXT NOT NULL,           -- e.g. 'chat', 'note_summary', 'embedding'
  position     INTEGER NOT NULL,        -- 0 = primary, 1 = first fallback, …
  model_id     TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_slot, position)
);

-- ─────────────────────────────────────────────
-- Entity reviews (AI-generated recurring summaries per entity)
-- ─────────────────────────────────────────────
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

`
