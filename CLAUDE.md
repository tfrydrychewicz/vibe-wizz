# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Update this file whenever you complete a commitable increment** — reflect any new IPC channels, components, architectural decisions, or completed phase checklist items from DESIGN.md.

## Commands

```bash
npm run dev          # Start Electron app in dev mode with Vite HMR
npm run build        # Bundle with electron-vite and create macOS DMG
npm run typecheck    # Run vue-tsc + tsc for both renderer and main/preload
npm run rebuild      # Rebuild native modules (better-sqlite3) after Node/Electron version changes
npm run build:swift        # Compile Swift MicMonitor binary → resources/MicMonitor (macOS only)
npm run build:transcriber  # Compile Swift Transcriber .app bundle → resources/Transcriber.app (macOS only)
```

There is no test suite currently. TypeScript strict mode is enforced across both renderer and main/preload processes.

## Design & Roadmap

Full product design, feature specifications, data model details, and implementation phases/checklist are in [DESIGN.md](DESIGN.md). Read it before implementing new features.

## Architecture

This is an **Electron + Vue 3 + SQLite** desktop app with a 3-process structure:

### Process Boundaries

- **Main process** (`src/main/`): Window lifecycle, SQLite database initialization, and all IPC handlers. The DB layer lives entirely here.
- **Preload** (`src/preload/index.ts`): Context bridge — exposes a typed `window.api` surface to the renderer. This is the only safe communication channel.
- **Renderer** (`src/renderer/`): Vue 3 SPA. No Node access. Communicates with main exclusively via `window.api` IPC calls.

### Database Layer

- **better-sqlite3** with SQLite (WAL mode, FTS5, 64MB cache) + **sqlite-vec** for vector similarity search
- Schema in `src/main/db/schema.ts` — 14 tables including `notes`, `note_templates`, `note_chunks`, `entities`, `entity_mentions`, `note_relations`, `action_items`, `calendar_events`, `settings` + vec0 virtual tables `chunk_embeddings`, `summary_embeddings`, `cluster_embeddings`
- IPC handlers in `src/main/db/ipc.ts`:
  - Notes: `db:status`, `notes:create`, `notes:get`, `notes:update`, `notes:list`, `notes:delete`, `notes:restore`, `notes:delete-forever`, `notes:search`, `notes:get-archived-status`, `notes:get-link-count`
  - Templates: `templates:list`, `templates:create`, `templates:get`, `templates:update`, `templates:delete`
  - Entity types: `entity-types:list`, `entity-types:create`, `entity-types:update`, `entity-types:delete`
  - Entities: `entities:list`, `entities:create`, `entities:get`, `entities:update`, `entities:delete`, `entities:restore`, `entities:delete-forever`, `entities:search`, `entities:get-mention-count`, `entities:get-trash-status`
  - Trash: `trash:list`
  - Settings: `settings:get`, `settings:set`
  - Search: `notes:semantic-search`
  - Action Items: `action-items:list`, `action-items:create`, `action-items:update`, `action-items:delete`
  - Calendar Events: `calendar-events:list`, `calendar-events:create`, `calendar-events:update`, `calendar-events:delete`
- `notes:delete` is a soft-delete (sets `archived_at`) and also clears `linked_note_id` on any `calendar_events` that referenced it; `notes:restore` clears `archived_at`; `notes:delete-forever` replaces all `[[noteLink]]` nodes in other notes' bodies with plain text of the note title, cleans up `note_relations`, then hard-deletes (FK `ON DELETE SET NULL` auto-clears `calendar_events.linked_note_id`)
- `notes:get-link-count` — `{ id }` → `{ count }`: count of distinct notes that `[[link]]` to this note (from `note_relations`); used for trash confirmation in `NoteList` and delete-forever confirmation in `TrashView`
- `entities:delete` is a soft-delete (sets `trashed_at`, returns `{ ok, mentionNoteCount }`); `entities:restore` clears `trashed_at`; `entities:delete-forever` replaces all `@mention` nodes in note bodies with plain text before hard-deleting
- `entities:get-mention-count` — `{ id }` → `{ count }`: count of distinct notes mentioning the entity (from `entity_mentions`)
- `entities:search` — `{ query, type_id? }` → up to 20 non-trashed entities matching name (LIKE); optional `type_id` restricts results to a specific entity type; used by `@mention` suggestion and attendee entity search
- `entities:get-trash-status` — `{ ids: string[] }` → `Record<string, boolean>`: batch check which entity IDs are currently trashed
- `trash:list` — returns `{ notes: [{id, title, archived_at}], entities: [{id, name, trashed_at, type_id, type_name, type_icon, type_color}] }`
- `notes:create` accepts optional `{ title?, body?, template_id? }` params (defaults to `'Untitled'` blank note); when `template_id` is given, the template's body is copied in
- `templates:create/update` — `{ name, icon, body }` — templates stored in `note_templates` table; `icon` is a kebab-case Lucide name; `body` is TipTap JSON
- `notes:search` — `{ query }` → `[{ id, title }]`: up to 20 non-archived notes matching title (LIKE); used by `[[` note-link suggestion
- `notes:get-archived-status` — `{ ids: string[] }` → `Record<string, boolean>`: batch check which note IDs are archived
- `notes:update` now syncs both `entity_mentions` and `note_relations` after every save: **manual** `entity_mentions` (rebuilt from `mention` nodes, `mention_type='manual'`); `note_relations` (`relation_type = 'references'`) rebuilt from `noteLink` nodes; `auto_detected` mentions are managed separately by the NER pipeline and are NOT deleted on save
- `notes:list` returns only non-archived notes sorted by `updated_at DESC`; `entities:list` and `entities:search` exclude trashed entities
- `entities:list` takes `{type_id}` and returns non-trashed entities sorted by name
- `entities:search` takes `{query, type_id?}` and returns up to 20 non-trashed entities matching the name (LIKE); optional `type_id` filters by entity type
- `entity-types:delete` blocks deletion of built-in types (person, project, team, decision, okr)
- `settings:get` — `{ key }` → stored value string or null; `settings:set` — `{ key, value }` → upserts; known keys: `openai_api_key`, `anthropic_api_key`, `deepgram_api_key`, `elevenlabs_api_key`, `transcription_model` (`'elevenlabs'|'deepgram'|'macos'`), `transcription_language` (BCP-47 or `'multi'`), `calendar_slot_duration`, `meeting_note_title_template` (default `{date} - {title}`), `attendee_entity_type_id`, `attendee_name_field`, `attendee_email_field`
- `action-items:list` — `{ status?, source_note_id? }` → `ActionItem[]` (with `source_note_title`, `assigned_entity_name` via JOINs); non-cancelled by default; filter by status or source note
- `action-items:create` — `{ title, source_note_id?, assigned_entity_id?, due_date?, extraction_type?, confidence? }` → full row with joins
- `action-items:update` — `{ id, title?, status?, assigned_entity_id?, due_date? }` → `{ ok }`; sets/clears `completed_at` based on status
- `action-items:delete` — `{ id }` → `{ ok }`: hard-deletes the action item
- `notes:update` triggers `scheduleEmbedding(id)` fire-and-forget after save (no await); runs L1 chunk embeddings + L2 note summary (require sqlite-vec + OpenAI key), **NER entity detection**, and **action item extraction** (both require only Anthropic key) concurrently in background
- `notes:semantic-search` — `{ query }` → `[{ id, title, excerpt: string | null }]` (up to 15 notes): **hybrid FTS5 + vector search with Reciprocal Rank Fusion** — runs FTS5 keyword search (top 20) and KNN on `chunk_embeddings` (top 20) in parallel, merges via RRF (k=60), returns top 15 sorted by combined score; excerpt comes from the best-matching chunk; falls back to FTS5-only if vec not loaded or no API key
- `chat:send` — `{ messages: {role, content}[], searchQuery?: string }` → `{ content: string, references: {id, title}[] }`: FTS5 search on the last user message (top 5 notes) → inject as context into Claude Sonnet system prompt alongside calendar events (past 7 days + next 30 days, up to 50) and open/in-progress action items (up to 50) → parse `[Note: "Title"]` citations from response → return structured references; returns graceful message if no `anthropic_api_key` configured
- Migration on startup: `ALTER TABLE entities ADD COLUMN trashed_at TEXT` (idempotent try/catch)
- Dev DB: `wizz.dev.db`, Prod DB: `wizz.db` — both in Electron's `userData` directory

### Renderer / UI

- `App.vue` shell: sidebar with fixed nav items (Today, Notes, **Templates**) + **dynamic entity type list** (loaded from DB) + fixed items (Actions, Calendar, Search, Trash) + bottom buttons (Ask Wizz, Settings)
  - **Ask Wizz** button in sidebar bottom toggles `showChat`; `Cmd+J` keydown listener does the same; `ChatSidebar` renders as a fixed right panel (360px) over the main area
  - Entity type nav is populated from `entity-types:list` on mount; routes `activeView` to entity type IDs
  - "New entity type" button in sidebar opens `EntityTypeModal`
  - Main area uses `tabStore` for multi-tab/multi-pane content; `activeNoteId`/`activeEntityId` are **computed** from `activePane` (not stored as refs)
  - Notes and entity views share the same tab/pane content area on the right; clicking items in the left list opens them in the active pane; `Shift+click` opens a new pane; `Cmd+click` opens a new tab
  - `noteTemplates` loaded on mount and passed to `NoteList`; refreshed after every `onTemplateSaved`; used to populate the "New Note" template dropdown
- `src/renderer/stores/tabStore.ts` — tab/pane state for the content area: `OpenMode` (`'default' | 'new-pane' | 'new-tab'`), `ContentPane` (`{ id, type, contentId, typeId?, title }`), `Tab` (`{ id, panes, activePaneId }`); exports `tabs`, `activeTabId`, `activeTab`, `activePane`, `openContent`, `closePane`, `closeTab`, `setActiveTab`, `setActivePaneInTab`, `updatePaneTitle`, `closePanesForContent`
- `TabBar.vue` — horizontal tab bar rendered above the panes area when ≥2 tabs are open; each tab shows the active pane's title and a close button; emits `set-active-tab`, `close-tab`
- `NoteList.vue` — note list pane (240px); exposes `refresh()` via `defineExpose`; accepts optional `templates` prop (`{ id, name, icon }[]`); emits `select`, `open-new-pane`, `open-new-tab`, `new-note`, `new-note-from-template: [templateId]`, `trashed`; click handler checks `e.metaKey`/`e.shiftKey` to pick mode; when templates are present the "New Note" button shows a dropdown (blank note + template list); trash button triggers two-step flow (link count check → confirmation overlay → `notes:delete`); sets `noteArchivedStatus.set(id, true)` after archiving; emits `trashed` so `App.vue` can call `closePanesForContent`
- `NoteEditor.vue` uses **TipTap** (ProseMirror-based) for rich text editing with auto-save (500ms debounce); emits `saved: [title: string]` after each successful save; supports `@` entity mentions, `[[` note-links, and `/` slash commands; `@` and `[[` use `@tiptap/extension-mention` (renamed `noteLink` for the second) + `VueNodeViewRenderer`; `/` uses a custom `SlashCommandExtension` (TipTap `Extension` + `@tiptap/suggestion`) — typing `/action` shows `SlashCommandList` dropdown and on select opens an inline modal to create an action item linked to the current note; on note load, fetches trash/archived status and populates `entityTrashStatus`/`noteArchivedStatus`; emits `open-entity: [{ entityId, typeId, mode: OpenMode }]`, `open-note: [{ noteId, title, mode: OpenMode }]`
- `MentionList.vue` — keyboard-navigable entity suggestion dropdown rendered by `VueRenderer` into a fixed-position `document.body` div; exposes `onKeyDown` for TipTap suggestion integration
- `MentionChip.vue` — TipTap `VueNodeViewRenderer` component for `@mention` nodes; reads `entityTrashStatus` reactively; normal state: blue chip; trashed state: red chip with `Trash2` icon; fires clicks through `fireMentionClick` from mentionStore
- `EntityMentionPopup.vue` — fixed-position popup shown when clicking a non-trashed `@mention` chip; fetches entity via `entities:get`, displays name/type/fields; "Open →" button checks click modifiers and emits `open-entity: [{ entityId, typeId, mode: OpenMode }]`; default mode switches sidebar to entity type view
- `TrashedMentionPopup.vue` — fixed-position popup shown when clicking a trashed `@mention` chip; shows entity name + "in trash" message; Restore button calls `entities:restore` and updates `entityTrashStatus`; emits `close`, `restored`
- `NoteLinkList.vue` — keyboard-navigable note suggestion dropdown for `[[` trigger; shows matching note titles; appends "Create '...'" entry when query has no exact match (calls `notes:create` with title); exposes `onKeyDown`
- `NoteLinkChip.vue` — TipTap `VueNodeViewRenderer` for `noteLink` nodes; reads `noteArchivedStatus` reactively; normal: green chip `[[title]]`; archived: grey chip with `Archive` icon; fires clicks through `fireNoteLinkClick` from noteLinkStore
- `NoteLinkPopup.vue` — fixed-position popup shown when clicking a non-archived `[[note-link]]` chip; fetches note via `notes:get`; "Open →" button checks click modifiers and emits `open-note: [{ noteId, title, mode: OpenMode }]`; default mode switches sidebar to Notes view
- `TrashedNoteLinkPopup.vue` — fixed-position popup shown when clicking an archived `[[note-link]]` chip; shows note title + "This note is in trash"; Restore button calls `notes:restore` and sets `noteArchivedStatus.set(id, false)`; emits `close`, `restored`
- `TrashView.vue` — full-screen trash management view; calls `trash:list` on mount; Notes section + Entities section; Restore and Delete Forever actions for each; Restore note sets `noteArchivedStatus.set(id, false)`; Delete Forever note shows backlink count confirmation (via `notes:get-link-count`) before proceeding; Delete Forever entity shows mention count confirmation before proceeding; replaces main content area when `activeView === 'trash'`
- `EntityList.vue` — generic entity list pane (mirrors NoteList); props: `typeId`, `typeName`, `activeEntityId`; emits `select`, `open-new-pane`, `open-new-tab`, `new-entity`; exposes `refresh()`; click handler checks modifiers; trash button triggers two-step flow (count check → confirmation overlay → `entities:delete`)
- `EntityDetail.vue` — dynamic entity form; renders fields from entity type schema JSON; explicit Save button; props: `entityId`; emits `saved: [name: string]`, `trashed: [entityId]`; includes trash button with two-step confirmation
- `EntityTypeModal.vue` — full entity type creation modal with field builder (name, icon picker, color swatches, dynamic field list with type/options/entity_ref picker)
- `ActionsView.vue` — full-screen kanban board for action items (Open → In Progress → Done columns); shows AI badge on `ai_extracted` items; source note is a clickable link (plain/Shift/Cmd click for open modes); inline new-item form; refreshes on `note:actions-complete` push event
- `SlashCommandList.vue` — keyboard-navigable slash command dropdown used by the `/` suggestion in `NoteEditor`; follows same VueRenderer pattern as `MentionList`
- `SearchView.vue` — full-screen semantic search view (shown when sidebar Search is active); debounced text input (300ms); calls `notes:semantic-search`; shows note title + matching chunk excerpt per result; click/Shift+click/Cmd+click open modes; gracefully degrades to FTS when no API key
- `SettingsModal.vue` — macOS-style two-pane modal (AI | Calendar); **AI section**: OpenAI key, Anthropic key, **Transcription subsection** with segmented model picker (`ElevenLabs | Deepgram | macOS`) — ElevenLabs shows API key input only (auto-detects language from audio); Deepgram shows API key + language dropdown; macOS shows offline hint; **Calendar section**: slot duration, Meeting Note Title Template (`{date}`/`{title}` placeholders), Attendee Entity config (entity type + name field + email field); saves `transcription_model`, `transcription_language`, `elevenlabs_api_key`, `deepgram_api_key` in addition to other keys
- `ChatSidebar.vue` — fixed right panel (360px) for AI chat; toggled via "Ask Wizz" sidebar button or `Cmd+J`; messages stored in `chatStore` (session-only, no DB); sends `chat:send` IPC; renders `[Note: "Title"]` citations as clickable chips; note ref chips support all 3 open modes; emits `open-note`, `close`
- `src/renderer/stores/chatStore.ts` — module-level reactive state for AI chat: `messages` (`ChatMessage[]` with `role`, `content`, optional `references` and `error`), `isLoading`, `clearMessages()`; session-scoped (in-memory only)
- `LucideIcon.vue` — dynamic Lucide icon renderer; accepts `name` (kebab-case, e.g. `'user'`, `'bar-chart-2'`), `size`, `color` props; converts to PascalCase to look up the icon component from `lucide-vue-next`; falls back to `Tag` for unknown names
- `IconPicker.vue` — searchable Lucide icon grid picker (`v-model` stores kebab-case icon name); builds full icon list from `lucide-vue-next` exports at module load; filters by search query; shows up to 96 results; used in `EntityTypeModal`
- `TemplateList.vue` — template list pane (240px); exposes `refresh()`; emits `select: [id]`, `new-template`; click selects template; inline delete confirmation; shown in the Templates view
- `TemplateEditor.vue` — TipTap-based template editor; props: `templateId`; emits `saved: [name: string]`, `loaded: [name: string]`; auto-save 500ms debounce to `templates:update`; includes inline icon picker (via `IconPicker.vue`) and name input; same formatting toolbar as `NoteEditor` minus mention/link extensions; shows a hint about template usage
- `ToolbarDropdown.vue` is a reusable dropdown used in the editor toolbar
- `src/renderer/stores/mentionStore.ts` — module-level reactive state shared between `NoteEditor` and `MentionChip` (bypasses Vue injection isolation in TipTap NodeViews): `entityTrashStatus: reactive(Map<string, boolean>)`, `registerMentionClickHandler`, `fireMentionClick`
- `src/renderer/stores/noteLinkStore.ts` — same pattern for note-links: `noteArchivedStatus: reactive(Map<string, boolean>)`, `registerNoteLinkClickHandler`, `fireNoteLinkClick`
- Path alias: `@` resolves to `src/renderer/`
- Icons: **lucide-vue-next** throughout; entity type icons stored as kebab-case Lucide names (e.g. `'user'`, `'folder'`); built-in seeds migrated from emoji on startup via idempotent UPDATE statements in `schema.ts`
- Sidebar nav: fixed top items (Today, Notes, **Templates**) + dynamic entity type list + fixed bottom items (Actions, Calendar, Search, **Trash**, **Settings**)

### Navigation Shortcut Rule — ALWAYS FOLLOW

**Every button, link, or clickable element that opens a note or entity in the view pane MUST support all three open modes:**

| Modifier | Behaviour | Implementation |
|----------|-----------|----------------|
| Plain click | Open in current active pane | `openContent(..., 'default')` |
| `Shift+click` | Open in a new pane (split) in current tab | `openContent(..., 'new-pane')` |
| `Cmd+click` (macOS) / `Ctrl+click` (other) | Open in a new tab | `openContent(..., 'new-tab')` |

Pattern for any click handler that opens content:
```typescript
function onOpenSomething(e: MouseEvent, id: string): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  openContent('note' /* or 'entity' */, id, 'Untitled', mode, typeId?)
}
```

This applies to: list item clicks (`NoteList`, `EntityList`), "Open →" buttons in popups (`EntityMentionPopup`), any future "Go to" links, search result items, backlink entries, etc. **Do not add a new content-opening entry point without wiring up all three modes.**

### Key Design Decisions

- **Local-first**: All data on-device in SQLite; no cloud backend currently
- **Embedding pipeline** (`src/main/embedding/`): `chunker.ts` splits `body_plain` into ~1600-char sentence-bounded chunks with ~200-char overlap; `embedder.ts` lazy-initialises an OpenAI client (text-embedding-3-small, 1536d) keyed by API key from `settings`; `summarizer.ts` lazy-initialises an Anthropic client (claude-haiku-4-5-20251001) for L2 note summarization; `ner.ts` detects entity mentions via Claude Haiku (NER); `actionExtractor.ts` extracts action items via Claude Haiku (caps at 20 per note); `chat.ts` lazy-initialises an Anthropic client (claude-sonnet-4-6) for the AI chat sidebar — `setChatAnthropicKey(key)` / `sendChatMessage(messages, contextNotes)` — injects FTS5 search results as system-prompt context and instructs Claude to cite notes as `[Note: "Title"]`; `pipeline.ts` orchestrates fire-and-forget L1+L2+NER+Actions pipeline after every note save — all three Anthropic tasks (NER, action extraction) run concurrently with L1/L2 in a single `Promise.all`; NER upserts `auto_detected` rows in `entity_mentions`; action extraction replaces `ai_extracted` rows in `action_items` and pushes `note:actions-complete` to renderer; vec0 tables (`chunk_embeddings`, `summary_embeddings`, `cluster_embeddings`) store FLOAT[1536] embeddings as BLOBs; `note_chunks.id` (INTEGER PRIMARY KEY AUTOINCREMENT) = rowid in respective vec0 table; vec0 has NO ON DELETE CASCADE — pipeline deletes from vec0 tables before `note_chunks`; `isVecLoaded()` exported from `db/index.ts` — L1/L2 return early if false; L1 requires only `openai_api_key`; L2 additionally requires `anthropic_api_key`; NER and action extraction require only `anthropic_api_key` (run independently of sqlite-vec)
- **sqlite-vec loading**: `sqliteVec.load(db)` called after schema init in `db/index.ts`; both `sqlite-vec` and `sqlite-vec-darwin-arm64` (and other platform packages) are in `asarUnpack` so the dylib resolves to the real filesystem path in packaged app; graceful fallback on load failure (warning log, app continues without semantic search)
- **Chunked note storage**: `note_chunks` table stores L1 raw chunks (layer=1), L2 note summaries (layer=2), L3 cluster summaries (layer=3) for a future 3-layer embedding hierarchy (raw → summary → cluster) for semantic search
- **FTS5** is already wired up on `notes` for full-text search
- Entity graph: `entities` + `entity_mentions` + `note_relations` form a knowledge graph linking notes to people/projects/teams/decisions/OKRs; `entity_mentions` has two row types: `mention_type='manual'` (from TipTap `@mention` chips, rebuilt on every save) and `mention_type='auto_detected'` (from NER pipeline, `confidence` 0.0–1.0, rebuilt fire-and-forget after save); `entities:get-mention-count` counts `DISTINCT note_id` so both types are counted but deduplicated per note
- **Trash pattern**: entities use `trashed_at` (soft-delete); notes use `archived_at` (soft-delete); both have restore and delete-forever actions; `TrashView` in sidebar manages both; trashing from the list triggers a two-step confirmation flow when the item is linked/mentioned (entities: `entities:get-mention-count`; notes: `notes:get-link-count`); restore updates the module-level reactive status map (`entityTrashStatus` / `noteArchivedStatus`) so chips update without reloading notes; `closePanesForContent` is called on trash so open panes close immediately
- **Reactive mention chips**: `entityTrashStatus` (module-level `reactive(Map)`) drives chip appearance without re-loading notes — set on note load, on trash/restore anywhere in the app
- **Tab/pane system**: `tabStore` holds all content navigation state; `tabs` is a global (not per-view) array of `Tab` objects each with one or more `ContentPane`s; `Shift+click` adds a pane to the current tab (split view), `Cmd+click` opens a new tab; pane titles are updated on save via `updatePaneTitle`; trashing an entity closes all panes for it via `closePanesForContent`
- **Mic monitor** (`src/main/mic/monitor.ts`): spawns `resources/MicMonitor` Swift binary as a child process; reads JSON events line-by-line from stdout; on state change pushes `mic:active` / `mic:inactive` to renderer via `pushToRenderer()`; exports `startMicMonitor()`, `stopMicMonitor()`, `getMicStatus()`; auto-restarts on crash (max 5 attempts, 3s backoff); graceful no-op if binary missing. Binary path: `resources/MicMonitor` (dev) / `process.resourcesPath/MicMonitor` (prod). Build: `npm run build:swift` (compiles `swift/MicMonitor/Sources/main.swift` with `swiftc`). Binary is in `extraResources` in electron-builder config and `.gitignore`d.
- **Transcription pipeline** (`src/main/transcription/`): Three backends selected by `transcription_model` setting:
  - **ElevenLabs Scribe v2 Realtime** (`elevenlabs`): WS `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`; auth via `xi-api-key` header; audio sent as `{message_type:'input_audio_chunk', audio_base_64:base64}`; stop via empty chunk with `commit:true` + 500ms drain; 99 languages including Polish; renderer captures PCM 16kHz Int16 via `ScriptProcessorNode` → returns `audioFormat:'pcm'`
  - **Deepgram Nova-3** (`deepgram`): WS `wss://api.deepgram.com/v1/listen` with `nova-3`, `punctuate`, `smart_format`, `diarize`; auth via `Authorization: Token`; raw WebM/Opus binary; renderer uses `MediaRecorder` 250ms chunks → returns `audioFormat:'webm'`
  - **macOS SFSpeechRecognizer** (`macos`): spawns Swift `Transcriber.app` binary (offline via online Apple Speech servers); binary captures mic directly → returns `audioFormat:'none'`
  - `postProcessor.ts` — after stop: Claude Haiku meeting summary appended as `## Transcript Summary` + `### Raw Transcript` TipTap nodes to note body (DB direct write), then `scheduleEmbedding(noteId)`, pushes `transcription:complete`
- **MeetingPrompt.vue**: fixed bottom-right overlay; listens to `mic:active` / `mic:inactive` push events; shows after 5s debounce of continuous mic activity; three actions: **Transcribe** (sends `meeting-prompt:transcribe` with `{ eventId }` to main → creates/finds linked note → pushes `transcription:open-note` to main renderer), **Always transcribe** (saves `auto_transcribe_meetings=true` setting then triggers same), **Skip**; auto-transcribes on `mic:active` if `auto_transcribe_meetings=true` in settings; auto-dismisses on `mic:inactive`
- **NoteEditor.vue** transcription additions: "Start Transcription" / "Stop" button in the meeting context header; `startTranscription()` branches on `audioFormat`; **Transcriptions panel** at bottom of note (shown when `linkedCalendarEvent` is set AND recording or sessions exist): shows live text while recording + all stored sessions as collapsible rows (timestamp + duration, AI summary, expandable raw transcript); `loadTranscriptions()` called after `loadNote` and on `transcription:complete`; on stop, `expandedTranscriptIds` is reset so the new session auto-expands
- `src/renderer/stores/transcriptionStore.ts` — `pendingAutoStartNoteId: ref<string | null>` — set by App.vue on `transcription:open-note`, cleared by NoteEditor after auto-start; same module-level pattern as `mentionStore.ts`
- **CalendarView.vue** — full-screen calendar view; 4 view modes: day, work-week (Mon–Fri), week (Sun–Sat), month; time grid (7am–9pm, 64px/hour) for non-month views with events positioned absolutely; click empty slot → `MeetingModal` in create mode (pre-filled time); click event → `MeetingModal` in edit mode; prev/next/today navigation; fetches `calendar-events:list` on range change; emits `open-note`
- **MeetingModal.vue** — create/edit meeting modal; fields: title, date, start/end time, attendees (add/remove chips), **Meeting Notes** section (edit mode only: shows linked note with open/unlink, or "Create Meeting Notes" dashed button + "attach existing note" search input); two-step delete confirm; calls `calendar-events:create` or `calendar-events:update` on save; `calendar-events:delete` on delete; `CalendarEvent` type exported from here (id: number, external_id, title, start_at, end_at, attendees JSON string, linked_note_id, linked_note_title); attendee items type: `{ name, email, entity_id? }`; on mount loads `attendee_entity_type_id/name_field/email_field` settings — if all set, attendee input switches to entity search mode; "Create Meeting Notes" calls `notes:create` with title from `meeting_note_title_template`, then `calendar-events:update` to link it, emits `open-note` then `saved`; note search input (calls `notes:search`) selects an existing note to attach via `calendar-events:update`
- `calendar-events:list` — `{ start_at, end_at }` → `CalendarEvent[]` (with `linked_note_title` via LEFT JOIN); date range inclusive start, exclusive end, ordered by `start_at`
- `calendar-events:create` — `{ title, start_at, end_at, attendees?, linked_note_id? }` → full row; attendees stored as JSON string
- `calendar-events:update` — `{ id, title?, start_at?, end_at?, attendees?, linked_note_id?, transcript_note_id? }` → `{ ok }`; dynamic SET clause
- `calendar-events:delete` — `{ id }` → `{ ok }`; hard-delete
- `calendar-events:get-by-note` — `{ note_id }` → `CalendarEvent & { linked_note_title }` | null; finds the event that links to this note (used by NoteEditor to show meeting context header)
- `mic:active` (push) → `{ deviceName: string | null, timestamp: string }`; `mic:inactive` (push) → same; `mic:status` (invoke) → `{ isActive: boolean }`
- Transcription IPC (registered in `src/main/transcription/session.ts`):
  - `transcription:start` (invoke) — `{ noteId, eventId }` → `{ ok, audioFormat?, error? }`; routes by `transcription_model` setting: `'elevenlabs'` → ElevenLabs WS → `audioFormat:'pcm'`; `'deepgram'` → Deepgram WS → `audioFormat:'webm'`; `'macos'` → Swift binary → `audioFormat:'none'`; records `sessionStartedAt` for all backends
  - `transcriptions:list` (invoke) — `{ noteId }` → `StoredTranscription[]` sorted newest first; each row: `{ id, note_id, started_at, ended_at, raw_transcript, summary }`
  - `transcription:stop` (invoke) — → `{ ok }`; stops active backend, triggers post-processing in `postProcessor.ts`
  - `transcription:audio-chunk` (send) — `ArrayBuffer`; one-way; ElevenLabs: base64 JSON wrapped; Deepgram: raw binary; no-op for Swift
  - `transcription:status` (invoke) — → `{ isTranscribing, noteId }`
  - `transcription:partial` (push) — `{ text, isFinal }`; live transcript updates from all backends
  - `transcription:complete` (push) — `{ noteId }`; post-processing done, note updated with transcript summary
  - `transcription:error` (push) — `{ message }`; error during session
  - `transcription:open-note` (push) — `{ noteId, eventId, autoStart }` from `meetingWindow.ts` → main renderer; triggers note open + optional auto-start
- **Swift Transcriber binary** (`swift/Transcriber/Sources/main.swift`): SFSpeechRecognizer offline fallback; uses `SFSpeechRecognizer()` with no locale arg (always uses `Locale.current` = macOS system language); `requiresOnDeviceRecognition` intentionally NOT set (uses online Apple Speech servers; setting it true fails with "Siri disabled" if Siri is off); emits JSON lines (`ready`, `partial`, `error`) on stdout; graceful SIGTERM with 5s wait for final result; packaged as `.app` bundle (`resources/Transcriber.app/Contents/MacOS/Transcriber` + `Contents/Info.plist`) required by macOS 26 TCC for `NSSpeechRecognitionUsageDescription` lookup; built with `npm run build:transcriber`; managed by `src/main/transcription/swiftTranscriber.ts`
- Context isolation + sandbox enabled; no Node integration in renderer
