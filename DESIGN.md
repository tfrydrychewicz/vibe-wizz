# Wizz — AI-Native Second Brain for Engineering Managers

## Vision

Wizz is the operating system for an engineering manager's brain. It captures everything (meetings, notes, decisions, people context), connects it automatically, and surfaces the right information at the right time — so you spend less time organizing and more time leading.

## Design Principles

1. **Capture is effortless.** If it requires manual tagging, filing, or organizing, it's a bug.
2. **Context builds over time.** Every note, transcript, and interaction makes Wizz smarter. After 6 months, Wizz knows your org better than your wiki.
3. **AI acts, not just answers.** Wizz doesn't wait for queries — it proactively surfaces follow-ups, conflicts, and opportunities.
4. **Local-first, private by default.** Your management notes are sensitive. Data lives on your machine. Cloud is opt-in, only for AI inference.

## Target User

Senior engineering managers / directors managing 5-15 direct reports, multiple projects, and 15-30+ meetings/week. Primary platform: macOS. Primary languages: English and Polish.

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Shell | Electron + Vite | Cross-platform desktop, fast HMR |
| UI | Vue 3 + Composition API | Reactive, lightweight |
| Editor | TipTap (ProseMirror) | Rich text, extensible, mention support |
| Local DB | SQLite + sqlite-vec | Zero-config, embedded, vector search |
| FTS | SQLite FTS5 | Built-in, fast, good enough for local |
| AI inference | Claude API (Sonnet for bulk, Opus for synthesis) | Best reasoning, good multilingual |
| STT | Deepgram Nova-3 (cloud) + Whisper.cpp (fallback) | Nova-3 for accuracy + diarization; Whisper for offline/Polish |
| Native helper | Swift binary (mic detection) | CoreAudio metadata, no permissions needed |
| Sync (future) | CRDTs (Automerge) | Conflict-free multi-device sync |

### Why SQLite over PostgreSQL

PostgreSQL with pgvector is excellent server-side, but for a single-user desktop app:
- SQLite requires zero configuration, no daemon, no port management
- sqlite-vec provides HNSW vector search (cosine, L2) natively
- FTS5 handles full-text search without tsvector/GIN setup
- The entire database is a single file — trivial to backup, move, or restore
- Performance is more than sufficient for millions of rows on a single machine
- Users never see "connection refused" or need to run `pg_ctl start`

Keep PostgreSQL for the development/staging server if you build a cloud sync layer later.

---

## Data Model

### Core Tables

```
notes
├── id (ULID)
├── title
├── body (rich text JSON — TipTap document)
├── body_plain (extracted plain text for FTS)
├── template_id? → note_templates.id
├── source (manual | transcript | daily_brief | import)
├── language (detected, e.g. 'pl', 'en')
├── created_at
├── updated_at
└── archived_at?

note_chunks
├── id
├── note_id → notes.id
├── chunk_text
├── chunk_context (prepended context snippet for contextual retrieval)
├── embedding (FLOAT[1536])  — via sqlite-vec
├── layer (1=raw_chunk | 2=note_summary | 3=cluster_summary)
├── position (ordering within note)
└── created_at

entities
├── id (ULID)
├── name
├── type_id → entity_types.id
├── fields (JSON — dynamic fields per type)
├── created_at
└── updated_at

entity_types
├── id
├── name (e.g. "Person", "Project", "OKR", "Decision")
├── icon
├── schema (JSON — field definitions with types)
├── kanban_enabled (BOOLEAN)
├── kanban_status_field (which field to use as kanban column)
└── color

entity_mentions
├── id
├── note_id → notes.id
├── entity_id → entities.id
├── mention_type (manual | auto_detected)
├── confidence (0.0-1.0, for auto-detected)
├── char_offset_start
├── char_offset_end
└── created_at

note_relations
├── id
├── source_note_id → notes.id
├── target_note_id → notes.id
├── relation_type (references | follows_up | contradicts | supersedes)
├── strength (0.0-1.0, cosine similarity)
└── created_at

action_items
├── id (ULID)
├── title
├── body?
├── source_note_id → notes.id
├── assigned_entity_id? → entities.id (Person)
├── due_date?
├── status (open | in_progress | done | cancelled)
├── extraction_type (manual | ai_extracted)
├── confidence (0.0-1.0)
├── created_at
└── completed_at?

calendar_events
├── id
├── external_id (Google/Outlook event ID)
├── title
├── start_at
├── end_at
├── attendees (JSON array of email/name)
├── linked_note_id? → notes.id
├── transcript_note_id? → notes.id
├── recurrence_rule?
└── synced_at

daily_briefs
├── id
├── date
├── content (generated markdown)
├── calendar_snapshot (JSON)
├── pending_actions_snapshot (JSON)
├── generated_at
└── acknowledged_at?
```

### FTS5 Virtual Table

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(
    title, body_plain,
    content='notes',
    content_rowid='rowid',
    tokenize='unicode61'
);
```

### Vector Index (sqlite-vec)

```sql
-- Raw chunk embeddings
CREATE VIRTUAL TABLE chunk_embeddings USING vec0(
    id INTEGER PRIMARY KEY,
    embedding FLOAT[1536] distance_metric=cosine
);

-- Note summary embeddings (Layer 2)
CREATE VIRTUAL TABLE summary_embeddings USING vec0(
    id INTEGER PRIMARY KEY,
    embedding FLOAT[1536] distance_metric=cosine
);

-- Cluster summary embeddings (Layer 3)
CREATE VIRTUAL TABLE cluster_embeddings USING vec0(
    id INTEGER PRIMARY KEY,
    embedding FLOAT[1536] distance_metric=cosine
);
```

---

## Feature Specifications

### 1. Notes — The Core Primitive

**Editor**: TipTap-based rich text editor with:
- Markdown shortcuts (# for headings, - for lists, ``` for code blocks)
- `@` mention for entities (autocomplete from entity index)
- `[[` for note linking (wiki-style, autocomplete from note titles)
- `/` slash commands (insert template, create entity, add action item, insert date)
- Inline code blocks with syntax highlighting
- Drag-and-drop image embedding (stored locally in app data)

**Auto-save**: Debounced 500ms after last keystroke. No save button.

**Templates**: Users define note templates with:
- Predefined sections (e.g., "1:1 Template" → Agenda / Updates / Action Items / Notes)
- Pre-linked entity type (e.g., "1:1 with @Person" auto-prompts for person selection)
- Optional auto-creation trigger (e.g., "create from calendar event matching '1:1'")

**Background Processing** (on save, async):
1. Extract plain text → update FTS5 index
2. Chunk text (300-500 tokens, 50-token overlap) with contextual prefixes
3. Generate embeddings via Claude API (batch)
4. Auto-detect entity mentions (NER via Claude Haiku — fast, cheap)
5. Generate note summary (Layer 2) via Claude Sonnet
6. Detect and create note_relations based on entity overlap + embedding similarity
7. Extract action items via Claude Sonnet (if note source is transcript or contains action-like language)

### 2. Entities — Your Org Knowledge Graph

**Built-in Types** (pre-configured, user can modify):

| Type | Default Fields | Auto-detection |
|------|---------------|----------------|
| Person | name, role, team, email, manager, reports_to | Names in transcripts |
| Project | name, status, lead (→Person), team, priority | Project names in notes |
| Team | name, lead (→Person), members (→Person[]) | Team references |
| Decision | title, date, context_note (→Note), status, owner (→Person) | "We decided..." patterns |
| OKR | title, quarter, owner (→Person), key_results (text[]), status | OKR/goal mentions |

**Auto-enrichment**: When a Person entity is created with just a name, Wizz watches future notes/transcripts and progressively fills in role, team, email, preferences, communication style — surfacing suggestions for user confirmation.

**Entity Pages**: Each entity has a page showing:
- All fields
- Timeline of all notes/transcripts mentioning this entity (chronological)
- Related entities (co-mentioned, linked via fields)
- Open action items assigned to this entity
- AI-generated summary: "What I know about [entity]" — synthesized from all mentions

### 3. Meeting Transcription Pipeline

#### Detection (existing Swift binary — keep as-is)

Native Swift binary polls CoreAudio every 1s. On `mic_active`, Electron shows a frameless prompt:
- **Transcribe this meeting** (one-time)
- **Always transcribe** (auto for future)
- **Skip**

If calendar integration is active, the prompt shows the matching calendar event title.

#### Audio Capture

On user confirmation:
1. Electron uses `desktopCapturer` to capture system audio (loopback) — this captures all meeting participants
2. Simultaneously capture microphone input for the local user's voice
3. Stream both channels to the STT service

**Note**: System audio capture on macOS requires a virtual audio device (e.g., BlackHole or a custom Audio Server Plugin). Wizz bundles a lightweight virtual audio driver installed during onboarding.

#### Transcription

**Primary**: Deepgram Nova-3 via WebSocket streaming
- Real-time partial transcripts displayed in floating overlay
- Speaker diarization (distinguishes speakers)
- Language detection (auto-switches between English and Polish)
- Punctuation and formatting

**Fallback (offline)**: Whisper.cpp (medium model) running locally
- Triggered when Deepgram is unreachable
- Lower accuracy, no real-time streaming, but functional
- Good Polish language support with the medium multilingual model

#### Post-Meeting Processing

When meeting ends (mic deactivates for >60s or user manually stops):

1. **Create transcript note** linked to calendar event
2. **Speaker labeling**: Match diarized speakers to Person entities using voice profile (built over time) or calendar attendee list
3. **AI processing** (Claude Sonnet, single pass):
   - Generate structured meeting summary (topics discussed, decisions made, open questions)
   - Extract action items with assignees and deadlines
   - Detect new entities mentioned (people, projects) → suggest creation
   - Identify follow-ups needed
4. **Action items** auto-created in `action_items` table, linked to source transcript
5. **Notification**: Desktop notification with summary + "Review transcript" link

### 4. AI-Powered Retrieval (RAPTOR+)

#### Storage Layers (unchanged from original, adapted for SQLite)

| Layer | Content | Embedding Table | Refresh |
|-------|---------|----------------|---------|
| L1 — Chunks | 300-500 token chunks with contextual prefix | chunk_embeddings | On note save |
| L2 — Note summaries | LLM-generated, one per note | summary_embeddings | On note save |
| L3 — Cluster summaries | K-means clusters of related notes, LLM-summarized | cluster_embeddings | Nightly batch job |

#### Search Flow

```
User query
    │
    ├─ Step 1: Query expansion (Claude Haiku)
    │   "what do I know about microservices" →
    │   ["microservices", "service mesh", "API gateway", "distributed systems"]
    │
    ├─ Step 2: Parallel search
    │   ├─ FTS5 keyword search on notes_fts
    │   ├─ Vector search on cluster_embeddings (L3, top 5)
    │   │   └─ Drill into summary_embeddings (L2, top 10 per cluster)
    │   │       └─ Drill into chunk_embeddings (L1, top 5 per summary)
    │   └─ Graph traversal: follow note_relations from initial hits
    │
    ├─ Step 3: Reciprocal Rank Fusion
    │   Merge results from FTS, vector, and graph with RRF scoring
    │
    ├─ Step 4: Re-rank (Claude Haiku)
    │   Score each candidate chunk for relevance to original query
    │
    └─ Step 5: Synthesize (Claude Sonnet)
        Generate answer with citations [Note: "1:1 with Sarah, March 5"]
```

#### Proactive Retrieval (not query-driven)

While the user is writing a note, Wizz runs background retrieval:
- Every 10s (debounced), embed the current note content
- Find related notes via vector similarity
- Show a subtle sidebar: "Related: [Note title] — [1-line summary]"
- This creates serendipitous connections the user wouldn't have searched for

### 5. The Daily Brief

Every morning (configurable time, default 8:00), Wizz generates a briefing:

**Inputs:**
- Today's calendar events (from synced calendar)
- Open action items (sorted by due date)
- Overdue action items (flagged)
- Notes from the previous day
- Upcoming 1:1s this week + historical context for each person
- Any unacknowledged items from previous briefs

**Output** (generated by Claude Sonnet):

```markdown
# Tuesday, March 5 — Your Day

## 🔥 Needs Attention
- **Overdue**: Ship Bifrost migration plan (promised to @Sarah, Feb 28)
- **Today**: OKR review presentation at 2pm — last updated 2 weeks ago

## 📅 Today's Meetings
- 9:00  Standup (Platform Team) — @Bartek flagged a blocker yesterday
- 10:30 1:1 with @Sarah — Topics from last time: promotion timeline,
        on-call rotation concerns. She had an action item to draft the
        new runbook.
- 14:00 OKR Review — You're presenting Platform team Q1 results
- 16:00 1:1 with @Bartek — Last 1:1 was Jan 28 (5 weeks ago ⚠️)

## ✅ Action Items Due This Week
- [ ] Review @Sasha's design doc for event pipeline (due Wed)
- [ ] Send headcount request to @Director (due Fri)
- [ ] Follow up with @John re: vendor evaluation (no due date, 3 weeks old)

## 💡 Worth Revisiting
- You noted "revisit caching strategy after load test" on Feb 20 —
  load test completed yesterday per @Bartek's standup note.
```

The brief appears as a special note type, pinned to the top of the day view. Users can acknowledge items (removes from future briefs), snooze, or convert any line into an action item.

### 6. Action Items & Kanban

**Action items are first-class citizens, not a separate module.**

Sources:
- AI-extracted from meeting transcripts (auto)
- AI-extracted from notes (auto, with user confirmation)
- Manually created via `/action` slash command in any note
- Created from Daily Brief items

Every action item links back to its source note. This is critical — you can always trace "why does this task exist?"

**Kanban views** are configurable per entity type:
- Default: Action Items kanban (Open → In Progress → Done)
- Custom: Any entity type with `kanban_enabled` can have a board
- Filters: by assignee, by project, by due date range, by source note
- Drag-and-drop status changes

**Follow-up intelligence**: If an action item is assigned to a Person entity and hasn't been updated in N days (configurable, default 7), Wizz surfaces it in the Daily Brief with context: "Assigned to @Sarah on Feb 20 during Platform standup. No updates in 12 days."

### 7. Calendar Integration

**Sync**: OAuth2 with Google Calendar and/or Microsoft Graph (Outlook).
- Pull events every 5 minutes
- Store in `calendar_events` table
- Match attendees to Person entities (by email)

**Smart Linking**:
- When creating a note, suggest linking to today's/recent calendar events
- When a transcript is generated, auto-link to the matching event
- Before a meeting, show a "prep" panel: previous notes from meetings with same attendees, open action items for attendees, relevant project context

**Meeting Prep** (triggered 5 min before event, optional):
- Desktop notification: "Meeting with @Sarah in 5 min"
- Click to open a prep note with AI-generated context from previous interactions

### 8. Command Palette & AI Chat

**Command Palette** (`Cmd+K`):
- Quick navigation to any note, entity, or view
- Fuzzy search across titles, entity names, recent items
- Action shortcuts: "New note", "New 1:1 with...", "Show today's brief"

**AI Chat Sidebar** (`Cmd+J`):
- Natural language queries against your knowledge base
- "What did we decide about the migration timeline?"
- "Summarize my last 3 meetings with the platform team"
- "Draft a status update for Project Bifrost based on this week's notes"
- "What are all of Sarah's open action items?"
- Answers include citations linking to source notes
- Conversation context persists within a session

### 9. Data Portability

**Import**:
- Markdown files (Obsidian vault, any .md collection)
- Notion export (HTML/Markdown)
- Apple Notes (via AppleScript export)
- CSV (for entity bulk import)

**Export**:
- Full database as SQLite file
- All notes as Markdown with YAML frontmatter
- All entities as JSON/CSV
- Meeting transcripts as timestamped text files

**Backup**: Automatic daily backup of SQLite file to user-configured location (local folder, iCloud Drive, etc.)

---

## Offline Behavior

| Feature | Online | Offline |
|---------|--------|---------|
| Note editing | ✅ | ✅ |
| FTS search | ✅ | ✅ |
| Vector search | ✅ (new embeddings) | ✅ (cached embeddings only) |
| Meeting transcription | ✅ (Deepgram) | ✅ (Whisper.cpp, reduced quality) |
| AI summaries / extraction | ✅ (Claude) | ❌ (queued for when online) |
| Daily Brief | ✅ | ❌ (generated when reconnected) |
| Calendar sync | ✅ | ✅ (cached events, no updates) |
| AI Chat | ✅ | ❌ |

Offline-created notes are queued for embedding/processing and handled automatically when connectivity is restored.

---

## UX Architecture

### Navigation

```
┌─────────────────────────────────────────────────┐
│ Sidebar                    Main Area             │
│ ┌───────────┐  ┌──────────────────────────────┐ │
│ │ 📋 Today   │  │                              │ │
│ │ 📝 Notes   │  │  [Note Editor / Entity Page  │ │
│ │ 👥 People  │  │   / Kanban / Daily Brief /   │ │
│ │ 📁 Projects│  │   AI Chat / Search Results]  │ │
│ │ ✅ Actions │  │                              │ │
│ │ 📅 Calendar│  │                              │ │
│ │ 🔍 Search  │  │                              │ │
│ │ ────────── │  │                              │ │
│ │ ⚙ Settings │  │                              │ │
│ └───────────┘  └──────────────────────────────┘ │
│                  [Context Sidebar (optional)] → │ │
│                  Related notes / Entity details  │
└─────────────────────────────────────────────────┘
```

- **Today**: Daily Brief + today's calendar + recent notes
- **Notes**: All notes, filterable by template, date range, linked entities
- **People / Projects / etc.**: Entity list views (one per entity type)
- **Actions**: Action items list + kanban view
- **Calendar**: Week/day view with linked notes overlaid
- **Search**: AI-powered search + FTS results

### Key Interactions

- `Cmd+N` — New note
- `Cmd+K` — Command palette
- `Cmd+J` — AI chat sidebar
- `Cmd+Shift+T` — Today view
- `@` in editor — Entity mention
- `[[` in editor — Note link
- `/` in editor — Slash commands

---

## Implementation Phases

### Phase 1 — Foundation 
- [x] Electron + Vue + Vite scaffold
- [x] SQLite database with FTS5
- [x] TipTap note editor with auto-save
- [x] Basic note CRUD + list view
- [x] Entity types + entity CRUD
- [x] `@` mentions in editor
- [x] Add support for entity trash 
- [x] Add support for entity mention store
- [x] Add support for tabs and multi-pane view to the right pane
    - `SHIFT+click` on the item opens it in a new pane (support multiple panes in one tab)
    - `Command+click` on the item opens it in a new tab.
- [x] `[[` mentions in editor, allowing to mention a note, or create new one.
- [x] Note templates

### Phase 2 — Intelligence
- [x] sqlite-vec integration + embedding pipeline
- [x] Chunking + contextual retrieval
- [x] Claude integration for note summaries (L2)
- [x] FTS + vector hybrid search
- [x] Auto entity detection (NER)
- [x] Action item extraction from notes (also available on `/` command in the note)
- [x] AI chat sidebar (basic)

### Phase 3 — Meetings
- [x] Swift mic detection binary
- [ ] Deepgram streaming transcription
- [ ] Transcript → structured note pipeline
- [ ] Speaker diarization + entity matching
- [ ] Post-meeting summary + action extraction
- [ ] Meeting prep notifications
- [ ] Calendar sync (Google Calendar)

### Phase 4 — Proactive AI
- [ ] Daily Brief generation
- [ ] Cluster summaries (L3) + nightly batch
- [ ] Graph RAG (note_relations)
- [ ] Follow-up intelligence
- [ ] Proactive related notes sidebar
- [ ] Query expansion + re-ranking

### Phase 5 — Polish & Portability
- [ ] Import (Markdown, Notion, CSV)
- [ ] Export (Markdown, JSON, SQLite)
- [ ] Automatic backups
- [ ] Offline mode (Whisper.cpp fallback)
- [ ] Kanban views
- [ ] Keyboard shortcuts + command palette
- [ ] Performance optimization

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| macOS audio capture requires virtual driver | High friction at install | Bundle BlackHole or build minimal Audio Server Plugin; clear onboarding UX |
| Claude API costs at scale (millions of chunks) | Expensive | Use Haiku for NER/re-ranking, Sonnet for synthesis; batch embeddings; cache aggressively |
| sqlite-vec maturity | Potential bugs | Keep pgvector as fallback path; sqlite-vec is actively maintained by Alex Garcia |
| Deepgram cost for heavy meeting users | ~$0.01/min adds up | Offer Whisper.cpp as free-tier default; Deepgram as premium |
| Scope creep (notes + CRM + tasks + calendar + AI) | Never ships | Phase 1 is usable standalone; each phase adds value independently |
| Polish language STT accuracy | Core user need | Deepgram Nova-3 supports Polish; Whisper medium is strong for Polish; test early |
