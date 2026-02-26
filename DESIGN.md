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
| STT | ElevenLabs Scribe v2 Realtime (primary cloud) + Deepgram Nova-3 (secondary cloud) + macOS SFSpeechRecognizer via Swift (offline fallback) | Scribe v2: 99 languages, <150ms latency, Polish WER ≤5%; Deepgram: speaker diarization; SFSpeechRecognizer: fully offline, no API key |
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

note_transcriptions
├── id (UUID)
├── note_id → notes.id (ON DELETE CASCADE)
├── started_at (ISO 8601 — when recording started)
├── ended_at? (ISO 8601 — when recording stopped; null if session crashed)
├── raw_transcript (TEXT — accumulated STT output)
└── summary (TEXT — Claude Haiku-generated; written after recording ends; empty if AI fails or key not set)

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

### Schema Migration Policy

**All database schema changes must be delivered as migration files.** The app checks its schema version on every startup and applies pending migrations before the UI is shown.

- Migrations live in `src/main/db/migrations/`
- Each migration is a TypeScript file named `NNNN_description.ts` exporting a `Migration` object with `version` (integer), `name`, and `up(db)` function
- All migrations must be registered in `ALL_MIGRATIONS` in `src/main/db/migrations/index.ts`
- Applied migrations are tracked in the `schema_migrations` table (`version`, `name`, `applied_at`)
- **Adding a new table**: add `CREATE TABLE IF NOT EXISTS` to `SCHEMA_SQL` in `schema.ts` (for fresh installs) AND create a migration (for existing installs)
- **Adding a column to an existing table**: create a migration file only — do NOT touch `schema.ts`
- No `down()` / rollback — local-first single-user desktop app
- Current migrations: `0001` (`entities.trashed_at`), `0002` (`action_items.updated_at`)

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
- **Tables**: Insert 3×3 table via toolbar (Table2 button); right-click any table cell for a context menu (add/delete row or column, delete table, merge/split cells); column resize handles; GFM tables from AI chat rendered correctly
- **AI inline generation** (two entry points):
  - *Space on empty line*: pressing `Space` at the start of a completely empty paragraph opens `AIPromptModal` in insert mode; a "Type Space for AI" hint appears on the focused empty line when the note has content (`AILinePlaceholder` extension via ProseMirror decoration); on submit the empty paragraph is replaced with AI-generated content
  - *Selection bubble menu*: selecting text or a table shows a floating `BubbleMenu` (TipTap v3 / Floating UI) with a sparkles AI button; clicking it opens `AIPromptModal` in replace mode with the selected text pre-loaded as context; on submit the selection is replaced with AI-generated content
  - Both modes call the `notes:ai-inline` IPC handler: FTS5 keyword search on the prompt (top 5 notes for context) + `generateInlineContent()` (Claude Haiku, `max_tokens 1500`) + `parseMarkdownToTipTap()` → TipTap JSON nodes inserted/replacing via `deleteRange` + `insertContentAt` (single undo step); returns `{ error }` if no Anthropic API key

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

On user confirmation, Wizz activates the configured transcription backend and — when **System Audio Capture** is enabled — simultaneously launches the `AudioCapture.app` binary that mixes system output + microphone into one PCM stream:

1. **Microphone only** (default): renderer captures mic via `getUserMedia` and sends chunks to the cloud STT service
2. **System Audio Capture** (opt-in, requires macOS 14.2+): `AudioCapture.app` captures both system output (Zoom/Meet remote participants) and the local microphone, mixes them, and streams them to the cloud STT service — the renderer captures no audio itself

#### System Audio Capture — `AudioCapture.app`

`AudioCapture.app` is a Swift `.app` bundle (`swift/AudioCapture/Sources/main.swift`) packaged under `resources/AudioCapture.app/Contents/MacOS/AudioCapture`. Built with `npm run build:audiocapture`.

**Capture approach — ScreenCaptureKit SCStream:**

Wizz uses Apple's `ScreenCaptureKit` framework (`SCStream` with `capturesAudio=true`) to tap system audio output, which is the officially supported macOS API for capturing what plays through speakers/headphones during Zoom/Meet calls. A separate `AVAudioEngine` captures the microphone input.

This approach was chosen over Core Audio Taps (`AudioHardwareCreateProcessTap`) for its stability; SCStream is the Apple-supported way to get system audio on macOS 13+.

**Binary architecture:**

```
┌────────────────────────────────────────────────────────────────┐
│  AudioCapture.app (Swift binary — runs as child of main proc)  │
│                                                                 │
│  SCStream (capturesAudio=true)    AVAudioEngine.inputNode       │
│   ├── Float32 PCM (any rate/ch)    ├── Float32 PCM (native fmt) │
│   └── resample → 16kHz mono        └── resample → 16kHz mono   │
│            │   appendSysAudio()              │  appendMicAudio() │
│            ▼                                ▼                   │
│   sysBuf[32768]  (sysPos)       micBuf[32768]  (micPos)        │
│            └─────────── NSLock (bufLock) ─────────────┘        │
│                                 │                               │
│   DispatchSourceTimer (256ms)   │                               │
│   ├── sysF = min(sysPos, 4096)  │                               │
│   ├── micF = min(micPos, 4096)  │                               │
│   ├── outBuf[max(sysF, micF)]   │                               │
│   ├── outBuf += sysBuf[0..sysF] + micBuf[0..micF] (additive)  │
│   ├── compact each buffer independently                         │
│   ├── attenuate × 0.6, clamp, convert to Int16                  │
│   └── emit {"type":"audio_chunk","data":"<base64 PCM Int16>"}  │
└────────────────────────────────────────────────────────────────┘
```

**Key design decision — separate buffers:**

Each audio source has its own ring buffer (`sysBuf`/`sysPos` for SCStream, `micBuf`/`micPos` for AVAudioEngine). The timer mixes them additively at drain time. This prevents the "sequential overflow" bug: if both sources write to a single shared buffer, their combined input rate (~32kHz effective) doubles the drain rate (~16kHz/256ms), filling the buffer in ~2 seconds and silently dropping all subsequent audio.

**Resampling:**

SCStream may deliver audio at the native device rate (e.g. 48kHz stereo) regardless of the requested 16kHz. A windowed box-filter averages input samples over each output sample's window (`halfW = max(0.5, ratio * 0.5)`) for anti-aliased downsampling. Fast path for already-16kHz mono audio (common when SCStream honors the configuration).

**Protocol (stdout JSON lines):**

| Message | Meaning |
|---------|---------|
| `{"type":"ready"}` | Binary started, both streams active |
| `{"type":"audio_chunk","data":"<base64>"}` | 256ms PCM Int16 16kHz mono chunk |
| `{"type":"error","message":"..."}` | Fatal error (permission denied, etc.) |

**Requirements:**
- macOS 14.2+ (SCStream audio on 13+; the setting is shown for 14.2+ to be safe)
- "Screen & System Audio Recording" permission (TCC: `NSScreenCaptureUsageDescription`)
- `NSMicrophoneUsageDescription` for AVAudioEngine mic access
- Both keys declared in `swift/AudioCapture/Info.plist` and in `mac.extendInfo` in `package.json`

**TypeScript wrapper** (`src/main/transcription/audioCapture.ts`):
- Spawns binary, parses stdout JSON lines, resolves `startAudioCapture()` promise on `ready`
- Calls `onChunk(Buffer)` for each PCM chunk; routes chunk to active WS backend
- `stopAudioCapture()` sends SIGTERM; binary flushes and exits cleanly
- Rejects promise (surfaces as `transcriptionError` in NoteEditor) if binary not found, crashes, or emits error before ready

**Integration with transcription backends when `system_audio_capture = 'true'`:**

| Backend | WS URL change | Chunk routing |
|---------|--------------|---------------|
| ElevenLabs realtime | none | `onChunk` sends `{message_type:'input_audio_chunk', audio_base_64: buf.toString('base64')}` |
| ElevenLabs batch | none | `onChunk` pushes `buf` into `batchAudioChunks[]` |
| Deepgram | `encoding=linear16&sample_rate=16000` added | `onChunk` sends raw Buffer bytes |
| macOS Swift | N/A (mic captured inside binary) | N/A |

Returns `audioFormat: 'system-audio'` from `transcription:start` → renderer skips `getUserMedia` entirely.

#### Transcription Backends

Backend is selected automatically at session start based on which API keys are set in Settings (AI section):

**Tier 1 — ElevenLabs Scribe v2 Realtime** (when `elevenlabs_api_key` is set; takes priority over Deepgram)
- WebSocket: `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime[&language=xx]`
- Auth: `xi-api-key` header; audio sent as base64-encoded PCM 16kHz Int16 JSON messages
- Message format: `{ message_type: "input_audio_buffer.append", audio_base_64: "<base64>" }`
- Stop gracefully: send `{ message_type: "input_audio_buffer.commit" }`, wait 500ms, then close
- Events: `partial_transcript` → live preview; `committed_transcript` → accumulated to final
- 99 languages including Polish (WER ≤5%), <150ms latency

**Tier 2 — Deepgram Nova-3** (when `deepgram_api_key` is set and ElevenLabs key is absent)
- WebSocket: `wss://api.deepgram.com/v1/listen` with `encoding=webm`, `language=multi` (or specific), `punctuate`, `diarize`, `smart_format`
- Audio sent as raw WebM/Opus binary chunks (250ms `MediaRecorder` slices)
- Speaker diarization available; strong multilingual coverage

**Tier 3 — macOS SFSpeechRecognizer** (offline fallback; used when neither cloud key is set)
- Spawns `resources/Transcriber.app/Contents/MacOS/Transcriber` bundle (build with `npm run build:transcriber`)
- On-device Apple SFSpeechRecognizer; no API key required; works fully offline
- Language mapped from `transcription_language` setting via `LOCALE_MAP` in `swiftTranscriber.ts`
- Emits JSON lines (`ready`, `partial`, `error`) on stdout; graceful SIGTERM shutdown with up to 5s wait for final result

**Audio capture path per backend:**

| Backend | `system_audio_capture` | Renderer capture | IPC payload | Main → service |
|---------|----------------------|-----------------|-------------|----------------|
| ElevenLabs | `'false'` | `ScriptProcessorNode` (PCM 16kHz Int16) | `ArrayBuffer` | base64 JSON message |
| ElevenLabs | `'true'` | none | — | `AudioCapture.app` chunks via `onChunk` |
| Deepgram | `'false'` | `MediaRecorder` (WebM/Opus, 250ms) | `ArrayBuffer` | raw binary |
| Deepgram | `'true'` | none | — | `AudioCapture.app` chunks via `onChunk` (PCM WS) |
| Swift | either | none (binary accesses mic directly) | — | — |

`transcription:start` returns `{ ok, audioFormat }` where `audioFormat` is `'pcm'` (ElevenLabs mic-only), `'webm'` (Deepgram mic-only), `'none'` (Swift), or `'system-audio'` (AudioCapture.app active for either cloud backend), signaling the renderer which capture path to activate.

**Transcription Settings:**

| Setting key | Purpose | Default |
|-------------|---------|---------|
| `elevenlabs_api_key` | ElevenLabs Scribe v2 API key (tier 1) | — |
| `deepgram_api_key` | Deepgram Nova-3 API key (tier 2) | — |
| `transcription_language` | Language code (`multi`, `pl`, `en`, etc.) | `multi` |
| `system_audio_capture` | `'true'`/`'false'` — enable `AudioCapture.app` (macOS 14.2+, ElevenLabs/Deepgram only) | `'false'` |
| `save_debug_audio` | `'true'`/`'false'` — save each session's audio to `{userData}/debug-audio/` as WAV or WebM | `'false'` |

#### Live Note-Taking During Transcription

While a transcription session is active and linked to a note, the NoteEditor remains fully editable — the user can type notes, action items, or observations in real time alongside the live transcript. The **Transcriptions panel** (persistent, below the editor body) displays the live partial transcript stream during recording. After recording stops, the panel transitions seamlessly to show all stored sessions from `note_transcriptions` in reverse chronological order — each session as a collapsible row with timestamp, duration, AI summary, and expandable raw transcript. A note can be transcribed multiple times (start/stop cycles); every session is preserved.

#### Post-Meeting Processing

When meeting ends (mic deactivates for >60s or user manually stops):

1. **Merge transcript + manual notes**: the raw transcript (streamed from the active STT backend) and the user's hand-typed note content are merged into a single unified note. The merge strategy:
   - Manual notes take precedence and appear first (the user's intent is preserved)
   - Processed transcript (AI-structured: summary, topics, decisions) is appended as a distinct section (e.g. `## Transcript Summary`) so it's clearly attributed
   - Raw verbatim transcript stored separately (accessible but collapsed by default)
2. **Speaker labeling**: Match diarized speakers to Person entities using voice profile (built over time) or calendar attendee list
3. **AI processing** (Claude Sonnet, single pass):
   - Generate structured meeting summary (topics discussed, decisions made, open questions)
   - Extract action items with assignees and deadlines
   - Detect new entities mentioned (people, projects) → suggest creation
   - Identify follow-ups needed
4. **Action items** auto-created in `action_items` table, linked to source note
5. **Notification**: Desktop notification with summary + "Review notes" link

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

#### 7a. Calendar View (`CalendarView.vue`) — Implemented

**Four view modes**, selectable from the toolbar and persisted to settings (`calendar_view_mode`):

| Mode | Columns | Range |
|------|---------|-------|
| Day | 1 | Single date |
| Work Week | 5 | Mon–Fri of current week |
| Week | 7 | Sun–Sat of current week |
| Month | 7×N | Full calendar month grid |

**Time grid** (Day / Work Week / Week):
- Spans 7am–9pm (14 hours)
- Hour height is responsive: fills the scroll container, minimum 56px/hr
- Left gutter shows hour labels (7am…8pm in 12h format)
- Each day column is a separate scrollable vertical lane
- Today's column header shows the day number highlighted with a filled blue circle

**Interactions in time-grid views:**
- **Drag-to-create**: Click and drag on an empty slot → blue dashed preview block grows as you drag → on mouse-up opens `MeetingModal` in create mode with start/end pre-filled, snapped to `calendar_slot_duration` increments
- **Click event → edit**: A stationary click (no drag) on an event block opens `MeetingModal` in edit mode
- **Drag-to-move**: Click and hold on an event block → the original fades to 35% opacity, a dashed ghost follows the cursor across days and times → on mouse-up the event is updated in place (optimistic) and `calendar-events:update` is called
- **Resize**: Bottom edge of every event block has a 6px resize handle (`ns-resize` cursor) → drag to stretch/shrink the end time → updated optimistically and persisted on mouse-up
- **Slot duration**: Snap granularity loaded from settings (`calendar_slot_duration`, default 30 min); all drag operations snap to this increment

**Month view:**
- 7-column grid; rows auto-sized to `minmax(90px, 1fr)`
- Days outside the current month shown at 35% opacity
- Each day cell shows event chips (title + start time); click chip → edit modal; click empty cell → create modal pre-filled to 9:00–10:00am
- Today's date number highlighted with filled blue circle

**Toolbar:**
- ← / → navigation (previous/next day, week, or month depending on mode)
- "Today" button — jumps `currentDate` to now without changing view mode
- View mode switcher (segmented button group)
- "New" button — opens create modal with current timestamp

**Data fetching:** `calendar-events:list` called whenever `rangeStart`/`rangeEnd` computed values change (i.e., on navigation or mode switch). Local event list updated optimistically for move/resize; modal-saved events are upserted without a full reload.

---

#### 7b. Meeting Modal (`MeetingModal.vue`) — Implemented

Used for both creating and editing calendar events. Opened from `CalendarView` and (planned) other entry points.

**Fields:**
- **Title** — free text input, required; `Enter` submits
- **Date** — `<input type="date">`, YYYY-MM-DD
- **Start / End time** — `<input type="time">`, HH:MM; combined with date via `buildISO()` to produce a local-timezone ISO 8601 string (no `Z` suffix — stored as local time)
- **Attendees** — two modes depending on settings:
  - *Entity search mode* (when `attendee_entity_type_id` + `attendee_name_field` + `attendee_email_field` are all set in Settings): autocomplete searches entities of the configured type; selecting an entity reads `nameField` and `emailField` from the entity's field JSON; stored with `entity_id`
  - *Free-form mode* (default): separate Name + Email inputs, added on Enter or `+` button
  - Attendee chips show name (bold) + email; × button removes; stored as JSON array in `calendar_events.attendees`

**Meeting Notes section** (edit mode only — hidden in create mode):
- If `linked_note_id` is set: shows the note title as a clickable link (opens the note, all 3 open modes supported via click modifiers) + an unlink `×` button
- If no linked note: two options side by side:
  1. **"Create Meeting Notes"** dashed button — calls `notes:create` with title generated from `meeting_note_title_template` setting (default `{date} - {title}`, where `{date}` = long locale date string and `{title}` = event title), then calls `calendar-events:update` to link it, then emits `open-note` to open it in the active pane
  2. **"or attach existing note…"** search input — FTS search via `notes:search`; selecting a result links it via `calendar-events:update` and persists immediately

**Save:** `calendar-events:create` (create mode) or `calendar-events:update` (edit mode) with all fields. Attendees serialised as JSON. Error shown inline below the form.

**Delete:** Two-step confirmation (Delete button → "Delete this meeting? Yes / Cancel"). Calls `calendar-events:delete`.

**Settings that affect MeetingModal:**

| Setting key | Purpose | Fallback |
|-------------|---------|---------|
| `attendee_entity_type_id` | Entity type ID for attendee search | free-form mode |
| `attendee_name_field` | Field name for attendee name (`__name__` = entity primary name) | entity.name |
| `attendee_email_field` | Field name for attendee email | empty |
| `meeting_note_title_template` | Template for auto-generated note title | `{date} - {title}` |

---

#### 7c. Meeting Context Header in NoteEditor — Implemented

When a note is opened that has a calendar event linked to it (`calendar-events:get-by-note`), a non-editable header bar appears above the editor body showing:
- Event title
- Formatted time range (e.g. "Mon, Feb 25 · 10:00am – 11:00am")
- Attendee chips (parsed from the event's JSON attendees array)
- **"Start Transcription" / "Stop" button** — second entry point for transcription (in addition to the meeting detection prompt); clicking "Start Transcription" invokes `transcription:start`, selects the appropriate backend based on configured API keys, and begins audio capture; button changes to "Stop" while active; visible whenever the note has a linked event (mic does not need to be active)
- **Transcriptions panel** (persistent, below the editor body): present whenever the note has any transcription history or an active recording session. During recording: shows the live partial transcript stream at the top. After recording ends (`transcription:complete`): reloads from `transcriptions:list` and renders all stored sessions as collapsible rows. Each row shows:
  - Start date/time and session duration
  - AI-generated summary (Claude Haiku, produced asynchronously after recording ends)
  - "Raw Transcript" expandable section with the full verbatim text
  - The most recent session auto-expands after each recording stops
  - Sessions are ordered newest-first; all are preserved (multi-session history per note)

This gives the note authoring context without needing to open the calendar, and lets users start transcription directly from their meeting notes while continuing to write by hand.

---

#### 7d. Meeting Detection Prompt (`MeetingPrompt.vue` + `meetingWindow.ts`) — Implemented

A frameless always-on-top `BrowserWindow` (320×190px, `floating` level so it appears above fullscreen apps) managed by `meetingWindow.ts`.

**Trigger flow:**
1. Swift `MicMonitor` binary polls CoreAudio every 1s, emits JSON on stdout
2. `monitor.ts` parses events and fires `micEvents`
3. `meetingWindow.ts` listens: on `mic:active` starts a **5-second debounce** before showing the prompt (avoids false positives from brief mic activations); resets if mic goes inactive
4. If `auto_transcribe_meetings = 'true'` in settings, the prompt is skipped and transcription is triggered directly
5. On `mic:inactive` the prompt is hidden with a 250ms animation delay

**Prompt UI:**
- "Meeting detected" header with red mic icon + close button
- Microphone device name (or "Microphone active" if unknown)
- **Meeting dropdown** (`<select>`): fetches today's calendar events via `calendar-events:list` on each `mic:active` event; lists events as "Title (9:00am–10:00am)"; "+ New Meeting" option always at the bottom
- **Auto-selection**: the dropdown auto-selects whichever event is **currently in progress** (now ≥ start && now ≤ end) or **starts within the next 10 minutes**; falls back to "+ New Meeting" if none qualify
- Action buttons: **Transcribe** · **Always transcribe** · **Skip**

**Actions:**
- **Skip / close ×**: sends `meeting-prompt:skip` IPC → `dismissed = true`, window hides; dismissed flag resets on next `mic:active`
- **Transcribe**: if "+ New Meeting" is selected, creates a `calendar-events:create` entry titled "New Meeting" (start = now, end = now + 1hr) before firing `meeting-prompt:transcribe` IPC (transcription is a no-op until Phase 3.2)
- **Always transcribe**: same as Transcribe but also writes `auto_transcribe_meetings = 'true'` to settings; future mic activations skip the prompt entirely
- **Dismissed state**: once dismissed in a mic session (any of the three actions), the prompt won't reappear until the mic goes inactive and becomes active again

> **Two transcription entry points**: transcription can be started from (1) this meeting detection prompt (mic-triggered, automatic) or (2) the **"Start Transcription" button in the NoteEditor meeting context header** (manual, note-linked event). Both paths converge on the same transcription pipeline and IPC channel (`meeting-prompt:transcribe`). See §7c.

---

#### 7e. IPC Reference — Calendar

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `calendar-events:list` | invoke | `{ start_at: ISO, end_at: ISO }` | `CalendarEvent[]` with `linked_note_title` via LEFT JOIN, ordered by `start_at` |
| `calendar-events:create` | invoke | `{ title, start_at, end_at, attendees?, linked_note_id? }` | full `CalendarEvent` row |
| `calendar-events:update` | invoke | `{ id, title?, start_at?, end_at?, attendees?, linked_note_id? }` | `{ ok }` (dynamic SET) |
| `calendar-events:delete` | invoke | `{ id }` | `{ ok }` (hard-delete) |
| `calendar-events:get-by-note` | invoke | `{ note_id }` | `CalendarEvent & { linked_note_title }` \| null |
| `meeting-prompt:skip` | send | — | hides prompt, sets dismissed |
| `meeting-prompt:transcribe` | send | — | hides prompt, triggers transcription (Phase 3.2) |
| `meeting-prompt:always-transcribe` | send | — | saves setting, hides prompt, triggers transcription |

**`CalendarEvent` type** (exported from `MeetingModal.vue`):
```ts
interface CalendarEvent {
  id: number                    // INTEGER PRIMARY KEY (not ULID)
  external_id: string | null    // future: Google/Outlook event ID
  title: string
  start_at: string              // ISO 8601 local time (no Z)
  end_at: string
  attendees: string             // raw JSON string → AttendeeItem[]
  linked_note_id: string | null
  transcript_note_id: string | null
  recurrence_rule: string | null
  synced_at: string
  linked_note_title: string | null  // JOIN field, not in DB column
}
```

---

#### 7f. IPC Reference — Transcription

Transcription IPC channels registered in `src/main/transcription/session.ts`:

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `transcription:start` | invoke | `{ noteId, eventId? }` | `{ ok, audioFormat: 'pcm'\|'webm'\|'none', error? }` |
| `transcription:stop` | invoke | — | `{ ok }` |
| `transcription:audio-chunk` | send | `ArrayBuffer` | — (one-way) |
| `transcription:status` | invoke | — | `{ isTranscribing, noteId }` |
| `transcription:partial` | push | `{ text, isFinal }` | — |
| `transcription:complete` | push | `{ noteId }` | — |
| `transcription:error` | push | `{ message }` | — |
| `transcription:open-note` | push | `{ noteId, eventId, autoStart }` | — |
| `transcriptions:list` | invoke | `{ noteId }` | `NoteTranscription[]` sorted by `started_at DESC` |

**`NoteTranscription` type:**
```ts
interface NoteTranscription {
  id: string
  note_id: string
  started_at: string        // ISO 8601
  ended_at: string | null
  raw_transcript: string
  summary: string           // empty string if AI unavailable
}
```

**`audioFormat` behaviour:**
- `'pcm'` → renderer uses `ScriptProcessorNode` at 16kHz; chunks sent as `Int16Array` buffers
- `'webm'` → renderer uses `MediaRecorder` (WebM/Opus, 250ms); chunks sent as raw binary
- `'none'` → Swift binary captures mic internally; renderer sends no audio chunks
- `'system-audio'` → `AudioCapture.app` is active; renderer skips `getUserMedia` entirely; `transcription:audio-chunk` IPC is a no-op

---

#### 7g. Planned (Future Phases)

- **Google Calendar / Outlook sync**: OAuth2 pull every 5 min, match attendees to Person entities by email; populate `external_id`, `recurrence_rule`
- **Meeting prep notifications**: desktop notification 5 min before event; click opens a prep note with AI-generated context from previous meetings with the same attendees
- **Smart linking**: suggest linking an open note to today's events; auto-link transcript to matching event by time overlap
- **Speaker diarization + entity matching** (deeper): match Deepgram/ElevenLabs diarized speakers to Person entities using voice profile (built over time); current implementation matches by calendar attendee name via Claude Haiku post-processing
- **Post-meeting action extraction from transcript**: dedicated transcript-aware extraction pass that runs after `postProcessor.ts`; extracts action items with assignees and deadlines, creates rows in `action_items`, links to source note

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
- **Image attachments**: paste images from clipboard (`Cmd+V` in textarea) or drag-and-drop onto the sidebar; attached images appear as 64×64px thumbnails in a bar above the input with a ✕ remove button; on send the images are forwarded to Claude as vision content blocks (base64, Anthropic Vision API); sent images are shown as 100×100px thumbnails in the conversation history below the user's message bubble; supported formats: JPEG, PNG, GIF, WebP
- **Entity `@` mentions**: typing `@` in the chat input opens a floating entity picker (debounced search via `entities:search`, up to 8 results with name + type badge); selecting an entity inserts `@EntityName` at the cursor and adds a blue `@Name · TypeName` chip to the context bar; entity IDs are sent as `mentionedEntityIds` in `chat:send` → main process fetches `EntityContext[]` (id, name, type_name) from DB → injected into the system prompt as `[id:uuid] @Name (type: TypeName)` so Claude can correctly resolve entity IDs when assigning tasks, and validate that the entity type is appropriate for the operation

### 8a. AI Actions — Agentic Command Execution

**Overview**: The AI chat sidebar can execute Wizz operations directly from natural language. Instead of only answering questions, the assistant understands commands and performs them — creating meetings, updating action item statuses, rescheduling events — returning a confirmation alongside its prose response.

**Supported actions (initial scope):**

| Category | Operations | Example prompts |
|----------|-----------|-----------------|
| Calendar | create, update, delete | "Schedule a retro Friday at 3pm", "Move tomorrow's standup to 10am", "Cancel the 2pm sync" |
| Action items | create, update (title/status/due/assignee), delete | "Add a task: review Sasha's PR by Wednesday", "Mark the runbook task as done", "Assign the vendor eval to @John" |

**Intent detection — Claude tool use, not regex:**

`chat.ts` passes a set of tool definitions to the Claude API with every message. Claude decides autonomously whether to call a tool or reply conversationally — no keyword matching or separate intent classifier needed. The full set of defined tools:

```typescript
const WIZZ_TOOLS: Tool[] = [
  {
    name: 'create_calendar_event',
    description: 'Create a new calendar event.',
    input_schema: {
      type: 'object',
      properties: {
        title:     { type: 'string' },
        start_at:  { type: 'string', description: 'ISO 8601 local time, no Z' },
        end_at:    { type: 'string', description: 'ISO 8601 local time, no Z' },
        attendees: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } } }
      },
      required: ['title', 'start_at', 'end_at']
    }
  },
  {
    name: 'update_calendar_event',
    description: 'Update fields on an existing calendar event. Resolve event ID from context before calling.',
    input_schema: {
      type: 'object',
      properties: {
        id:       { type: 'number' },
        title:    { type: 'string' },
        start_at: { type: 'string' },
        end_at:   { type: 'string' },
        attendees: { type: 'array', items: { type: 'object' } }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete a calendar event. ALWAYS describe what you are about to delete and ask the user to confirm before calling this tool.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'number' } },
      required: ['id']
    }
  },
  {
    name: 'create_action_item',
    description: 'Create a new action item / task.',
    input_schema: {
      type: 'object',
      properties: {
        title:              { type: 'string' },
        due_date:           { type: 'string', description: 'ISO 8601 date' },
        assigned_entity_id: { type: 'string', description: 'Entity ID of the Person to assign' },
        source_note_id:     { type: 'string' }
      },
      required: ['title']
    }
  },
  {
    name: 'update_action_item',
    description: 'Update an existing action item. Resolve item ID from context before calling.',
    input_schema: {
      type: 'object',
      properties: {
        id:                 { type: 'string' },
        title:              { type: 'string' },
        status:             { type: 'string', enum: ['open', 'in_progress', 'done', 'cancelled'] },
        due_date:           { type: 'string' },
        assigned_entity_id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'delete_action_item',
    description: 'Delete an action item. ALWAYS describe what you are about to delete and ask the user to confirm before calling this tool.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id']
    }
  }
]
```

**Execution flow (single `chat:send` round-trip):**

```
User: "Schedule a retro on Friday at 3pm"
    │
    ├─ Step 1: chat.ts sends messages[] + WIZZ_TOOLS to Claude
    │
    ├─ Step 2: Claude responds stop_reason='tool_use'
    │   tool_use: { name: 'create_calendar_event',
    │               input: { title: 'Retro', start_at: '2026-02-27T15:00',
    │                         end_at: '2026-02-27T16:00' } }
    │
    ├─ Step 3: chat.ts executes the corresponding DB operation directly
    │   (calls the same logic as calendar-events:create IPC handler)
    │   result: { id: 42, title: 'Retro', ... }
    │
    ├─ Step 4: result appended as tool_result message; loop back to Claude
    │
    └─ Step 5: Claude produces final response (stop_reason='end_turn')
        content: "Done! I've scheduled **Retro** for Friday Feb 27, 3–4pm."
        actions: [{ type: 'created_event', payload: { id: 42, title: 'Retro', ... } }]
```

The tool loop runs entirely inside `chat.ts` — `chat:send` still resolves with a single `{ content, references, actions }` response. Multi-tool turns (e.g. create then update) are handled by iterating until `stop_reason !== 'tool_use'`.

**Destructive action confirmation:**

Delete tools include in their `description` the instruction to always seek confirmation before calling. Claude will therefore respond conversationally ("Should I delete **Retro** on Friday?") when delete intent is detected. The user confirms ("yes, go ahead") and the delete executes on the next turn. If the user phrased the original command as an unambiguous delete ("yes delete that retro"), Claude may call the tool immediately on the first turn.

**`chat:send` response — extended type:**

```typescript
interface ExecutedAction {
  type:
    | 'created_event'   | 'updated_event'   | 'deleted_event'
    | 'created_action'  | 'updated_action'  | 'deleted_action'
  payload: CalendarEvent | ActionItem | { id: number | string }  // deleted: id only
}

interface ChatResponse {
  content: string
  references: { id: string; title: string }[]   // existing — note citations
  actions: ExecutedAction[]                       // new — executed tool results
}
```

No new IPC channel required. Tool execution is internal to the `chat:send` handler.

**ChatSidebar action cards:**

Executed actions are rendered as compact cards below the assistant's text message:

```
┌──────────────────────────────────────────┐
│ ✅  Created event                         │
│  Retro · Fri Feb 27 · 3:00–4:00pm        │
│                              Open in Calendar → │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ ✅  Action item marked done               │
│  Review Sasha's PR                       │
│                              Open in Actions → │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│ 🗑  Deleted event                         │
│  Friday Retro                            │
└──────────────────────────────────────────┘
```

Card colours: green for creates, blue for updates, muted red for deletes. "Open in…" buttons support all three navigation modes (plain / Shift / Cmd click).

**Resolving references from context:**

The system prompt already injects upcoming calendar events and open action items (see `chat:send` implementation). When the user says "move tomorrow's standup", Claude finds the matching event ID in the injected context and calls `update_calendar_event` with it directly. If multiple matches exist or the reference is ambiguous, Claude asks for clarification before calling any tool.

**Error handling:**

If a tool call fails (DB error, item not found), the error is returned as a `tool_result` with `is_error: true`. Claude sees the error text and responds naturally: "I couldn't find that meeting — can you tell me more about when it is?" The failed tool call is omitted from `actions[]` in the response.

---

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
| Meeting transcription | ✅ (ElevenLabs / Deepgram) | ✅ (macOS SFSpeechRecognizer, on-device, no API key) |
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
- [x] Meetings + Meetings CRUD + Displaying meetings in the calendar
    - Meeting fields are editable
    - Calendar supports different views: single day, working days in the week, week, month
    - Drag-to-create, drag-to-move, resize events in time-grid views
    - Slot duration configurable in Settings; view mode persisted across sessions
- [x] Meeting detection prompt with today's meeting selector
    - Auto-selects the meeting in progress or starting within 10 minutes
    - "New Meeting" option creates a calendar event and links it to the transcription session
    - "Always transcribe" writes setting to skip the prompt on future mic activations
- [x] Meeting Notes — create or attach a note to a calendar event
    - "Create Meeting Notes" generates a note titled from `meeting_note_title_template` and links it
    - "Attach existing note" FTS search input links any existing note
    - Linked note shown as clickable chip in MeetingModal (all 3 open modes)
    - NoteEditor shows meeting context header (title, time, attendees) for notes linked to a calendar event
- [x] Attendee entity configuration in Settings
    - Choose entity type, name field, and email field for attendee autocomplete in MeetingModal
- [x] Multi-backend streaming transcription: ElevenLabs Scribe v2 Realtime (tier 1), Deepgram Nova-3 (tier 2), macOS SFSpeechRecognizer via Swift binary (tier 3 / offline) — triggered from meeting prompt **and** NoteEditor meeting context header; backend auto-selected based on configured API keys
- [x] Transcript → structured note pipeline (`postProcessor.ts`: Claude Haiku summary + raw transcript appended as TipTap nodes to linked note; `note_transcriptions` row persisted per session; embedding pipeline triggered after)
- [x] Post-meeting summary (basic): Claude Haiku generates structured meeting summary (Meeting Summary / Key Decisions / Follow-ups); stored in `note_transcriptions.summary` and appended to note body
- [x] Multi-session transcription history: each start/stop cycle persists to `note_transcriptions`; Transcriptions panel in NoteEditor shows all sessions (newest-first) with timestamps, durations, AI summaries, and expandable raw transcripts
- [x] Speaker diarization + entity matching: Deepgram word-level `words` array parsed into speaker segments (`[Speaker N]: text`); on stop, calendar event attendee names fetched and passed to `postProcessor.ts`; Claude Haiku maps speaker IDs → attendee names; labels replaced before storing `raw_transcript` and generating merged note
- [x] Post-meeting action extraction from transcript (action items currently extracted from note body by general pipeline; dedicated transcript-aware extraction pending)
- [x] System audio capture — `AudioCapture.app` Swift bundle using ScreenCaptureKit SCStream (system output) + AVAudioEngine (mic), separate buffers for each source, windowed-average resampler, 256ms PCM Int16 chunks to ElevenLabs/Deepgram; `system_audio_capture` setting in Settings → AI (ElevenLabs/Deepgram tabs only); returns `audioFormat:'system-audio'` → renderer skips `getUserMedia`; Deepgram opens PCM WebSocket variant (`encoding=linear16&sample_rate=16000`); `stopAudioCapture()` on `cleanupSession()`
- [x] WebSocket disconnect handling — `handleUnexpectedClose(code)` in `session.ts` called from all three WS close handlers (`openElevenLabsSocket`, `openDeepgramSocket`, `openDeepgramSocketPcm`); saves partial transcript and runs post-processing when server closes connection mid-session
- [x] Debug audio saving — `save_debug_audio` setting in Settings → Debug tab; when enabled, PCM chunks (or WebM) collected during session and written as WAV/WebM to `{userData}/debug-audio/` on session end; `debug:open-audio-folder` IPC opens folder in Finder
- [ ] Meeting prep notifications
- [ ] Calendar sync (Google Calendar)

### Phase 4 — Proactive AI
- [x] Make the AI also aware of the meetings and actions
- [x] AI Actions — natural language calendar and action item CRUD via Claude tool use (§8a): extend `chat.ts` with `WIZZ_TOOLS` definitions + tool-call execution loop; extend `chat:send` response with `actions: ExecutedAction[]`; render action cards in `ChatSidebar.vue`
- [x] Image attachments in AI chat — paste from clipboard or drag-and-drop onto sidebar; thumbnail bar above input; images forwarded as Anthropic Vision base64 content blocks on the last user message; thumbnails shown in conversation history
- [x] Daily Brief generation
- [x] Cluster summaries (L3) + nightly batch — K-means++ on L2 summary embeddings (K=√(N/2), 2–20), Claude Haiku cluster theme summaries, stored in `note_chunks(layer=3)` + `cluster_embeddings`; `scheduler.ts` runs at startup if >23h since last run; semantic search upgraded with +0.05 cluster boost on top of FTS5+L1 RRF
- [x] Graph RAG (note_relations) — after FTS5 seed retrieval in `chat:send`, walks 1-hop in the knowledge graph: bidirectional `[[wiki-link]]` neighbors via `note_relations` (up to 5, ranked by overlap count) + `@entity` co-occurrence neighbors via `entity_mentions` (up to 5); indexes added on `note_relations(source_note_id/target_note_id)`; system prompt updated to tell Claude context includes graph-connected notes; backlinks footer in `NoteEditor.vue` shows count of incoming `[[links]]` and expands to a clickable list (all 3 open modes) via new `notes:get-backlinks` IPC
- [x] Follow-up intelligence — `updated_at` column added to `action_items` (migration in `db/index.ts`); `action-items:update` stamps `updated_at` on every change; `dailyBrief.ts` reads `followup_staleness_days` (default 7) and `followup_assignee_entity_type_id` settings, filters stale open items assigned to entities of that type, injects a `STALE FOLLOW-UPS` section into the Daily Brief prompt; Settings → AI → "Follow-up Intelligence" subsection: pick assignee entity type + staleness threshold
- [x] Entity `@` mentions in AI chat — `@` trigger in chat textarea opens entity picker (floating dropdown, debounced `entities:search`, keyboard navigation); on select inserts `@Name` text and adds entity chip to context bar; chips persist for the session, can be removed manually; `chat:send` accepts `mentionedEntityIds?: string[]` → main fetches `EntityContext[]` and passes to `sendChatMessage()` as new 8th param; Claude receives entity context block (`[id:uuid] @Name (type: TypeName)`) enabling it to assign tasks to correct entity IDs and validate entity types
- [x] Proactive related notes sidebar
- [x] Query expansion + re-ranking

### Phase 5 — Polish & Portability
- [x] Table support in editor — `@tiptap/extension-table*`; toolbar insert button; right-click context menu (`TableContextMenu.vue`) for add/delete row/col, delete table, merge/split cells; CellSelection preserved on right-click via `mousedown` guard; GFM table parsing in `postProcessor.ts` so AI-generated notes render tables correctly; system prompts updated with GFM table syntax
- [x] AI inline generation — Space on empty line + selection bubble menu (see §1 Editor above); `AIPromptModal.vue`, `AILinePlaceholder.ts` extension, `notes:ai-inline` IPC, `generateInlineContent()` in `chat.ts`
- [ ] Import (Markdown, Notion, CSV)
- [ ] Export (Markdown, JSON, SQLite)
- [ ] Automatic backups
- [ ] Improved offline mode (macOS SFSpeechRecognizer already implemented as tier 3 fallback; this item covers improving quality and on-device model selection)
- [ ] Kanban views
- [x] Keyboard shortcuts + command palette
- [ ] Performance optimization

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| System audio capture permission (Screen &amp; System Audio Recording) | User may deny TCC prompt | Graceful error surfaced in NoteEditor; mic-only fallback works without permission; `NSScreenCaptureUsageDescription` declared in `AudioCapture.app` Info.plist and `mac.extendInfo` |
| Claude API costs at scale (millions of chunks) | Expensive | Use Haiku for NER/re-ranking, Sonnet for synthesis; batch embeddings; cache aggressively |
| sqlite-vec maturity | Potential bugs | Keep pgvector as fallback path; sqlite-vec is actively maintained by Alex Garcia |
| STT API cost for heavy users | ~$0.01/min adds up | Three-tier fallback: ElevenLabs → Deepgram → macOS SFSpeechRecognizer (free, offline); users without API keys get working transcription at zero cost |
| Scope creep (notes + CRM + tasks + calendar + AI) | Never ships | Phase 1 is usable standalone; each phase adds value independently |
| Polish language STT accuracy | Core user need | ElevenLabs Scribe v2 WER ≤5% for Polish; SFSpeechRecognizer has strong Polish support on macOS 13+; test early with real recordings |
