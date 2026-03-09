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
npm run build:audiocapture # Compile Swift AudioCapture .app bundle → resources/AudioCapture.app (macOS only)
```

There is no test suite currently. TypeScript strict mode is enforced across both renderer and main/preload processes.

**If `npm`/`node` is not on PATH** (common in non-interactive shells): find the node binary with `find /Users/tfrydrychewicz -name "node" -type f` (expect `~/.nvm/versions/node/<version>/bin/node`), then prepend its bin dir inline:
```bash
export PATH="$HOME/.nvm/versions/node/v20.19.1/bin:$PATH" && npm run typecheck
```

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
- Schema in `src/main/db/schema.ts` — 15 tables including `notes`, `note_templates`, `note_chunks`, `entities`, `entity_mentions`, `note_relations`, `action_items`, `calendar_events`, `settings`, `entity_reviews` + vec0 virtual tables `chunk_embeddings`, `summary_embeddings`, `cluster_embeddings`
- **Migration system** (`src/main/db/migrations/`): `runMigrations(db)` called in `initDatabase()` after `SCHEMA_SQL` and before sqlite-vec loading; tracks applied versions in `schema_migrations` table (`version`, `name`, `applied_at`); bootstraps existing DBs by stamping prior migrations as applied (detects via `entities.trashed_at` canary column); **NEVER change the DB schema except via a migration file** — new tables go in both `schema.ts` (for fresh installs) and a migration file (for existing installs); new columns on existing tables go in a migration file only; current migrations: `0001` (`entities.trashed_at`), `0002` (`action_items.updated_at`), `0003` (recurrence columns on `calendar_events`), `0004` (`recurrence_instance_date`), `0005` (`calendar_sources` table + `source_id` on `calendar_events`), `0007` (`ai_providers`, `ai_models`, `ai_feature_models` tables — seeds from existing `anthropic_api_key`/`openai_api_key` settings; sets default chains for all feature slots), `0008` (GTD columns on `action_items`: `parent_id`, `project_entity_id`, `contexts`, `energy_level`, `is_waiting_for`, `waiting_for_entity_id`, `someday`, `weekly_review_at`; creates indexes `idx_action_items_parent`, `idx_action_items_project`, `idx_action_items_waiting`), `0010` (review columns on `entity_types`: `review_enabled`, `review_frequency`, `review_day`, `review_time`; creates `entity_reviews` table with index `idx_entity_reviews_entity`); to add a migration: create `src/main/db/migrations/NNNN_description.ts` and register it in `ALL_MIGRATIONS`
- IPC handlers in `src/main/db/ipc.ts`:
  - Notes: `db:status`, `notes:create`, `notes:get`, `notes:update`, `notes:list`, `notes:delete`, `notes:restore`, `notes:delete-forever`, `notes:search`, `notes:get-archived-status`, `notes:get-link-count`, `notes:get-backlinks`
  - Templates: `templates:list`, `templates:create`, `templates:get`, `templates:update`, `templates:delete`
  - Entity types: `entity-types:list`, `entity-types:create`, `entity-types:update`, `entity-types:delete`
  - Entities: `entities:list`, `entities:create`, `entities:get`, `entities:update`, `entities:delete`, `entities:restore`, `entities:delete-forever`, `entities:search`, `entities:get-mention-count`, `entities:get-trash-status`, `entities:find-by-email`
  - Trash: `trash:list`
  - Settings: `settings:get`, `settings:set`
  - Search: `notes:semantic-search`
  - Action Items: `action-items:list`, `action-items:create`, `action-items:update`, `action-items:delete`, `action-items:get`, `action-items:derive-attributes`, `action-items:get-subtasks`
  - Calendar Events: `calendar-events:list`, `calendar-events:create`, `calendar-events:update`, `calendar-events:delete`
  - Calendar Sources: `calendar-sources:list`, `calendar-sources:create`, `calendar-sources:update`, `calendar-sources:delete`, `calendar-sources:verify`, `calendar-sources:sync-now`, `calendar-sources:get-script`
  - Daily Briefs: `daily-briefs:get`, `daily-briefs:generate`, `daily-briefs:acknowledge`
  - AI Providers: `ai-providers:list`, `ai-providers:save`, `ai-providers:fetch-models`, `ai-providers:delete`
  - AI Feature Models: `ai-feature-models:list`, `ai-feature-models:save`
  - Entity Reviews: `entity-reviews:list`, `entity-reviews:generate`, `entity-reviews:acknowledge`, `entity-reviews:delete`
- `daily-briefs:get` — `{ date: string }` (YYYY-MM-DD) → `DailyBriefRow | null`: returns stored brief for that date without generating
- `daily-briefs:generate` — `{ date }` → `DailyBriefRow | { error: string }`: calls `generateDailyBrief()` (resolves model via `daily_brief` feature chain) then upserts into `daily_briefs`; ON CONFLICT resets `acknowledged_at = NULL`; returns `{ error }` if no AI provider configured
- `daily-briefs:acknowledge` — `{ date }` → `{ ok }`: sets `acknowledged_at` timestamp (brief has been viewed)
- `notes:delete` is a soft-delete (sets `archived_at`) and also clears `linked_note_id` on any `calendar_events` that referenced it; `notes:restore` clears `archived_at`; `notes:delete-forever` replaces all `[[noteLink]]` nodes in other notes' bodies with plain text of the note title, cleans up `note_relations`, then hard-deletes (FK `ON DELETE SET NULL` auto-clears `calendar_events.linked_note_id`)
- `notes:get-link-count` — `{ id }` → `{ count }`: count of distinct notes that `[[link]]` to this note (from `note_relations`); used for trash confirmation in `NoteList` and delete-forever confirmation in `TrashView`
- `notes:get-backlinks` — `{ id }` → `{ id, title }[]`: list of non-archived notes that `[[link]]` to this note, ordered by `updated_at DESC`; used by `NoteEditor` backlinks footer
- `entities:delete` is a soft-delete (sets `trashed_at`, returns `{ ok, mentionNoteCount }`); `entities:restore` clears `trashed_at`; `entities:delete-forever` replaces all `@mention` nodes in note bodies with plain text before hard-deleting
- `entities:get-mention-count` — `{ id }` → `{ count }`: count of distinct notes mentioning the entity (from `entity_mentions`)
- `entities:search` — `{ query, type_id? }` → up to 20 non-trashed entities matching name (LIKE); optional `type_id` restricts results to a specific entity type; used by `@mention` suggestion and attendee entity search
- `entities:get-trash-status` — `{ ids: string[] }` → `Record<string, boolean>`: batch check which entity IDs are currently trashed
- `entities:find-by-email` — `{ email, type_id, email_field }` → `{ id, name, type_id } | null`: look up a non-trashed entity by matching `JSON_EXTRACT(fields, '$.{email_field}')` against `email`; used by `SyncedEventPopup` to match attendee emails to person entities (first) and team entities (fallback) when attendee/team mapping is configured
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
- `settings:get` — `{ key }` → stored value string or null; `settings:set` — `{ key, value }` → upserts; known keys: `deepgram_api_key`, `elevenlabs_api_key`, `transcription_model` (`'elevenlabs'|'deepgram'|'macos'`), `transcription_language` (BCP-47 or `'multi'`), `elevenlabs_diarize` (`'true'|'false'`), `calendar_slot_duration`, `meeting_note_title_template` (default `{date} - {title}`), `attendee_entity_type_id`, `attendee_name_field`, `attendee_email_field`, `team_entity_type_id` (entity type used to match team distribution emails in meetings), `team_name_field`, `team_email_field`, `team_members_field` (field name on team entities that contains member names/refs used for speaker identification in transcription; supports `text_list` JSON arrays, `entity_ref_list` UUID arrays resolved to entity names, or comma/newline-delimited text), `cluster_last_run` (ISO timestamp of last successful L3 cluster batch run), `followup_staleness_days` (integer string, default `'7'`), `followup_assignee_entity_type_id` (entity type ID to monitor for stale follow-ups; empty string = disabled), `gtd_project_entity_type_id` (entity type used for project assignment in GTD), `gtd_contexts` (JSON array of default context tags), `web_search_enabled` (`'true'|'false'`, default off — enables the local DuckDuckGo `web_search` WIZZ_TOOL in AI chat; read in `chat:send` handler and passed to `sendChatMessage()`), `ai_personalization_html` (raw `innerHTML` of the Personalization `RichTextInput` — renderer-only, for UI restore on next open), `ai_personalization_text` (plain text extracted from the personalization preamble — injected into AI system prompts by `getPersonalizationPreamble()`), `ai_personalization_entity_ids` (JSON array of entity UUIDs mentioned in the preamble — merged into entity context in `chat:send`), `ai_personalization_note_ids` (JSON array of note UUIDs linked in the preamble — prepended to `pinnedNotes` in `chat:send`) — **NOTE**: `openai_api_key` and `anthropic_api_key` are legacy keys (migrated to `ai_providers` table by `0007`; no longer written by the UI)
- `action-items:list` — `{ status?, source_note_id?, project_entity_id?, is_waiting_for?, someday? }` → `ActionItem[]` (with `source_note_title`, `assigned_entity_name`, `project_name`, `waiting_for_name` via JOINs); non-cancelled by default
- `action-items:get` — `{ id }` → `ActionItem | null`: full row with joins for a single item; used by `TaskDetailPanel`
- `action-items:get-subtasks` — `{ parent_id }` → `ActionItem[]`: all non-cancelled sub-tasks of a parent
- `action-items:create` — `{ title, source_note_id?, assigned_entity_id?, due_date?, extraction_type?, confidence?, project_entity_id?, contexts?, energy_level?, is_waiting_for?, parent_id? }` → full row with joins
- `action-items:update` — `{ id, title?, status?, assigned_entity_id?, due_date?, project_entity_id?, contexts?, energy_level?, is_waiting_for?, waiting_for_entity_id?, someday?, parent_id? }` → `{ ok }`; sets/clears `completed_at` based on status; always stamps `updated_at` when any field changes; fires `action:updated` push event with `{ actionId }`
- `action-items:delete` — `{ id }` → `{ ok }`: hard-deletes the action item
- `action-items:derive-attributes` — `{ title, noteContext?, userContext? }` → `{ project_entity_id, project_name, due_date, contexts, energy_level, is_waiting_for, confidence }`: AI derivation via `taskClarifier.ts` (slot: `action_extract`); used by `/action derive` in NoteEditor and "Derive" button in TaskDetailPanel
- `action:updated` (push) → `{ actionId: string }`: fired after every `action-items:update`; consumed by `ActionsView` and `TaskDetailPanel` to refresh in-place
- `entity-reviews:list` — `{ entityId }` → `EntityReview[]` sorted newest first; each row: `{ id, entity_id, period_start, period_end, content, generated_at, model_id, acknowledged_at }`
- `entity-reviews:generate` — `{ entityId }` → `EntityReview | { error: string }`: manually triggers review generation via `generateEntityReview()` (slot: `entity_review`); gathers notes, tasks, calendar events in the period window; pushes `entity-review:complete` on success
- `entity-reviews:acknowledge` — `{ id }` → `{ ok }`: sets `acknowledged_at` timestamp on a review
- `entity-reviews:delete` — `{ id }` → `{ ok }`: hard-deletes a review
- `entity-review:complete` (push) → `{ entityId: string }`: fired after a review is generated (manual or scheduled); consumed by `EntityReviewPanel` to reload its list
- `entity-types:create` and `entity-types:update` now accept review configuration fields: `review_enabled` (0|1), `review_frequency` (`'daily'|'weekly'|'biweekly'|'monthly'`), `review_day` (day-of-week string e.g. `'Monday'`, required when frequency ≠ daily), `review_time` (HH:MM local, default `'07:00'`)
- `notes:update` triggers `scheduleEmbedding(id)` fire-and-forget after save (no await); runs L1 chunk embeddings + L2 note summary (require sqlite-vec + `embedding` feature chain model), **NER entity detection** (slot: `ner`), and **action item extraction** (slot: `action_extract`) concurrently in background
- `notes:semantic-search` — `{ query }` → `[{ id, title, excerpt: string | null }]` (up to 15 notes): **hybrid FTS5 + vector search with query expansion, RRF, and re-ranking** — (1) `expandQueryConcepts()` (slot: `query_expand`) + embedding (slot: `embedding`) in parallel; (2) FTS5 OR search on expanded terms (top 20) + KNN on `chunk_embeddings` (top 20); (3) RRF merge (k=60) + L3 cluster boost (+0.05); (4) `reRankResults()` (slot: `rerank`) re-ranks top 15; excerpt from best-matching chunk; gracefully degrades to FTS5-only if slots have no configured models
- `chat:send` — `{ messages, searchQuery?, mentionedEntityIds?, overrideModelId?, noteSelections? }` → `{ content, references, actions, entityRefs, warning? }`: FTS5 search + knowledge-base context injection → model via `chat` feature chain (or `overrideModelId` at chain front as first-priority model) with **WIZZ_TOOLS** (9 tools when web search enabled: create/update/delete calendar events and action items, create note, **`ensure_action_item_for_task`**, **`web_search`**) → **tool-use loop** (max 10 iterations); `noteSelections` (`NoteSelectionAttachment[]`) are prepended to the last user message as a `<note_selections>` XML block so Claude can reference specific parts of the note; `warning` field set when fallback model was used; returns graceful error if all chain entries fail; reads `web_search_enabled` setting and passes to `sendChatMessage()` — when true, adds `web_search` WIZZ_TOOL and fires `web-search:performed` push on each tool call
- `shell:open-external` (invoke) — `{ url: string }` → `{ ok }`; opens a URL in the user's default browser via Electron's `shell.openExternal()`; restricted to `http://` and `https://` URLs; used by click delegates for `.wizz-web-chip` elements in `ChatSidebar`, `TodayView`, `EntityReviewPanel`
- `web-search:performed` (push) → `{ query: string }`: fired each time the `web_search` WIZZ_TOOL is called inside `sendChatMessage()`; consumed by `ChatSidebar.vue` to show the `WebSearchIndicator` in-progress row
- `notes:ai-inline` payload extended with optional `noteSelections?: NoteSelectionAttachment[]`; formatted selections are prepended to the user prompt so inline AI generation is aware of pasted note content
- Migration on startup: `ALTER TABLE entities ADD COLUMN trashed_at TEXT` (idempotent try/catch)
- Dev DB: `wizz.dev.db`, Prod DB: `wizz.db` — both in Electron's `userData` directory

### Renderer / UI

- `App.vue` shell: sidebar with fixed nav items (Today, Notes, **Templates**) + **dynamic entity type list** (loaded from DB) + fixed items (Actions, Calendar, Search, Trash) + bottom buttons (Ask Wizz, Settings)
  - **Ask Wizz** button in sidebar bottom toggles `showChat`; `Cmd+J` keydown listener does the same; `ChatSidebar` renders as a fixed right panel (360px) over the main area
  - **Command palette** (`Cmd+K`) — `CommandPalette.vue` fixed overlay (z-index 1100); auto-focuses input; fuzzy-filters static commands (Navigate, Create, App sections) computed from `entityTypes` + `noteTemplates` props; live IPC search (`notes:search` + `entities:search`, debounced 200ms) when query ≥ 2 chars; ArrowUp/Down + Enter keyboard nav; emits `navigate`, `new-note`, `new-entity`, `open-note`, `open-entity`; special sentinel views `'__chat__'`/`'__settings__'` handled in `onPaletteNavigate()`
  - **Global keyboard shortcuts** handled in `onGlobalKeydown` (App.vue): `Cmd+K` command palette, `Cmd+J` AI chat, `Cmd+N` new note (guarded: skips if focus in input/contenteditable), `Cmd+,` settings, `Cmd+Shift+T` Today, `Cmd+Shift+A` Actions, `Cmd+F` Search (guarded), `Cmd+W` close active pane (guarded)
  - Entity type nav is populated from `entity-types:list` on mount; routes `activeView` to entity type IDs
  - "New entity type" button in sidebar opens `EntityTypeModal`
  - Main area uses `tabStore` for multi-tab/multi-pane content; `activeNoteId`/`activeEntityId` are **computed** from `activePane` (not stored as refs)
  - Notes and entity views share the same tab/pane content area on the right; clicking items in the left list opens them in the active pane; `Shift+click` opens a new pane; `Cmd+click` opens a new tab
  - `noteTemplates` loaded on mount and passed to `NoteList`; refreshed after every `onTemplateSaved`; used to populate the "New Note" template dropdown
- `src/renderer/stores/tabStore.ts` — tab/pane state for the content area: `OpenMode` (`'default' | 'new-pane' | 'new-tab'`), `ContentPane` (`{ id, type, contentId, typeId?, title }`), `Tab` (`{ id, panes, activePaneId }`); exports `tabs`, `activeTabId`, `activeTab`, `activePane`, `openContent`, `closePane`, `closeTab`, `setActiveTab`, `setActivePaneInTab`, `updatePaneTitle`, `closePanesForContent`
- `TabBar.vue` — horizontal tab bar rendered above the panes area when ≥2 tabs are open; each tab shows the active pane's title and a close button; emits `set-active-tab`, `close-tab`
- `NoteList.vue` — note list pane (240px); exposes `refresh()` via `defineExpose`; accepts optional `templates` prop (`{ id, name, icon }[]`); emits `select`, `open-new-pane`, `open-new-tab`, `new-note`, `new-note-from-template: [templateId]`, `trashed`; click handler checks `e.metaKey`/`e.shiftKey` to pick mode; when templates are present the "New Note" button shows a dropdown (blank note + template list); trash button triggers two-step flow (link count check → confirmation overlay → `notes:delete`); sets `noteArchivedStatus.set(id, true)` after archiving; emits `trashed` so `App.vue` can call `closePanesForContent`
- `NoteEditor.vue` uses **TipTap** (ProseMirror-based) for rich text editing with auto-save (500ms debounce); emits `saved: [title: string]` after each successful save; supports `@` entity mentions, `[[` note-links, and `/` slash commands; `@` and `[[` use `@tiptap/extension-mention` (renamed `noteLink` for the second) + `VueNodeViewRenderer`; `/` uses a custom `SlashCommandExtension` (TipTap `Extension` + `@tiptap/suggestion`) — typing `/action` shows `SlashCommandList` dropdown and on select opens an inline modal to create an action item linked to the current note; on note load, fetches trash/archived status and populates `entityTrashStatus`/`noteArchivedStatus`; emits `open-entity: [{ entityId, typeId, mode: OpenMode }]`, `open-note: [{ noteId, title, mode: OpenMode }]`; **Related notes panel**: `✨` toggle button in note header opens a 280px right side panel (inside `note-content-row` flex row) — calls `notes:semantic-search` with note title + first 500 chars of body text, filters out current note, shows up to 7 results with title + excerpt snippet; refreshes on each successful auto-save while panel is open; all result clicks support all 3 open modes; **Note selection copy**: `@copy` handler on `.note-body` calls `buildNoteSelectionAttachment()` and writes a `NoteSelectionAttachment` JSON to clipboard under the `NOTE_SELECTION_MIME` custom MIME type alongside the standard plain-text copy; pasting into `ChatSidebar` or `AIPromptModal` then renders a `NoteSelectionChip` instead of raw text
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
- `EntityDetail.vue` — dynamic entity form; renders fields from entity type schema JSON; explicit Save button; props: `entityId`; emits `saved: [name: string]`, `trashed: [entityId]`; includes trash button with two-step confirmation; mounts `<EntityReviewPanel>` below the fields form when `reviewEnabled` (derived from `entityType.review_enabled`)
- `EntityReviewPanel.vue` — self-contained review panel for `EntityDetail`; props: `entityId`, `reviewEnabled`; loads reviews via `entity-reviews:list`; subscribes to `entity-review:complete` push → reloads on match; persists collapse state in `localStorage`; renders each review as a collapsible card with a markdown preview (first 3 lines) and full `markdownToHtml` content; unacknowledged reviews show a dot badge; "Generate now" button calls `entity-reviews:generate` with spinner; per-review delete calls `entity-reviews:delete` with inline confirmation; hidden entirely when `reviewEnabled` is false
- `EntityTypeModal.vue` — full entity type creation modal with field builder (name, icon picker, color swatches, dynamic field list with type/options/entity_ref picker); includes **Automated Reviews** collapsible section: toggle (`review_enabled`), frequency picker (`daily|weekly|biweekly|monthly`), day-of-week picker (when frequency ≠ daily), time input (`review_time` HH:MM local); saves review config to `entity-types:create`/`entity-types:update`
- `ActionsView.vue` — full-screen GTD task manager; 4-tab layout: **Inbox** (no project), **Projects** (grouped by project entity), **Waiting** (is_waiting_for=1), **Someday** (someday=1); per-tab empty states with helpful instructions; "Weekly Review" button opens `GTDWeeklyReview.vue` slide-in panel; refreshes on `note:actions-complete` and `action:updated` push events; task cards open `TaskDetailPanel` via `taskDetailStore.openDetail`; global shortcut `Cmd+Shift+A` navigates here
- `TaskDetailPanel.vue` — right-side detail panel for a single GTD task; mounted in `App.vue` as a fixed overlay; fields: title (auto-save on blur/Enter), status select, project search (entity dropdown filtered by `gtd_project_entity_type_id`), assignee search, due date, contexts (tag input), energy level (Low/Med/High toggle buttons with `aria-pressed`), waiting-for toggle + entity search, sub-task list with inline add (`SubTaskInput`); source note chip; created/updated footer; subscribes to `action:updated` push for in-place refresh; all interactive fields have ARIA labels; `role="complementary"` on root; IPC: `action-items:get`, `action-items:update`, `action-items:get-subtasks`, `action-items:derive-attributes`
- `TaskCard.vue` — unified task card used in `ActionsView` and `TaskDetailPanel` sub-task list; props: `task: ActionItem`, `depth: number`, `showProject: boolean`, `showSourceNote: boolean`; emits `open-detail`, `status-changed`, `open-note`, `subtask-created`; renders GTD attribute chips inline; status toggle checkbox; "Derive" button fires `action-items:derive-attributes` with spinner state
- `TaskAttributeChip.vue` — small pill chip for GTD metadata; props: `type` (`'project'|'context'|'energy'|'waiting'`), `label`, `energyLevel?`, `removable?`; emits `remove`; colored per type
- `SubTaskInput.vue` — inline sub-task creation input; props: `parentId`, `sourceNoteId?`; emits `created: [ActionItem]`, `cancel`; calls `action-items:create` with `parent_id`; auto-focuses on mount
- `GTDWeeklyReview.vue` — slide-in panel for weekly review workflow; shows stale tasks, someday items, tasks without project; "Mark reviewed" stamps `weekly_review_at`; emits `close`
- `GTDSettingsPanel.vue` — GTD settings section rendered in SettingsModal "Actions" tab; project entity type picker (dropdown from `entity-types:list`), default contexts multi-tag input; saves `gtd_project_entity_type_id` and `gtd_contexts` settings
- `src/renderer/stores/taskDetailStore.ts` — module-level store for task detail panel: `openDetail(id: string)`, `registerOpenDetailHandler(fn)`, `activeTaskId: ref`; bypasses Vue injection for cross-component communication
- `SlashCommandList.vue` — keyboard-navigable slash command dropdown used by the `/` suggestion in `NoteEditor`; follows same VueRenderer pattern as `MentionList`; current slash commands: `task` (extract or blank), `action` (alias for extract), `date`, `callout` (info/warning/success/danger/tip), `chart` (Chart.js), `mermaid` (Mermaid diagram), `excalidraw` (Excalidraw whiteboard drawing)
- `SearchView.vue` — full-screen semantic search view (shown when sidebar Search is active); debounced text input (300ms); calls `notes:semantic-search`; shows note title + matching chunk excerpt per result; click/Shift+click/Cmd+click open modes; gracefully degrades to FTS when no API key
- `TodayView.vue` — full-screen Today view (`activeView === 'today'`); renders the Daily Brief for today's date as formatted markdown; on mount calls `daily-briefs:get` to check for an existing brief, then auto-acknowledges it; "Generate Daily Brief" button calls `daily-briefs:generate` (Claude Sonnet — requires Anthropic API key); "Regenerate" header button triggers regeneration; markdown rendered via shared `markdownToHtml()` from `src/renderer/utils/markdown.ts`; stores content in `daily_briefs` table
- `src/renderer/utils/mermaid.ts` — Mermaid singleton initializer and renderer; exports `renderMermaid(id: string, source: string): Promise<MermaidResult>` which wraps `mermaid.render()` in a try/catch and returns `{ svg: string, error: null }` on success or `{ svg: null, error: string }` on failure; `ensureMermaidInit()` is called lazily on first render (dark theme with Wizz design tokens, `securityLevel: 'loose'` required for Electron CSP compatibility); used only by `CodeBlockView.vue`
- `src/renderer/utils/excalidrawLoader.ts` — lazy loader for `@excalidraw/excalidraw` + React; exports `loadExcalidraw(): Promise<LoadedExcalidraw>` which dynamic-imports `react`, `react-dom/client`, and `@excalidraw/excalidraw` on first call and caches the result in module scope; subsequent calls return the cache instantly; also imports `@excalidraw/excalidraw/index.css` statically so Vite bundles it at build time; re-exports `ExcalidrawElement`, `OrderedExcalidrawElement`, `AppState`, `BinaryFiles` types for use by `ExcalidrawView.vue`; exports `requestExcalidrawAutoOpen()` / `consumeExcalidrawAutoOpen()` — session-only flag used by slash-command / toolbar insertion to open the editor immediately after creation without persisting `autoOpen` to the DB
- `ExcalidrawView.vue` — TipTap `VueNodeViewRenderer` component for the `excalidraw` atom node; three surfaces: (1) **view mode** — inline block with static SVG preview, View / Edit / ✨ Generate header buttons, drag-resize handle; (2) **edit modal** — Excalidraw React canvas mounted imperatively via `document.createElement` + `createRoot` (avoids Vue scoped-CSS/timing issues); Vue header rendered separately via `<Teleport to="body">` at z-index 1200; canvas container appended to body at z-index 1199 (`position:fixed; top:44px`); `openEditModal(initial?)` accepts optional `{ elementsJson, appStateJson }` for the AI-generate path; `collaborators: new Map()` always injected into `appState` to fix Excalidraw 0.17+ `.forEach` error; SVG exported with `exportBackground: false` (transparent); (3) **AI Generate overlay** — `<Teleport to="body">` dialog at z-index 1300; textarea prompt input (⌘Enter submits); calls `excalidraw:generate` IPC → on success opens edit modal pre-loaded with the AI elements so user can review/edit before saving; **Cancel** unmounts React; **Escape** closes whichever surface is open; **fullscreen lightbox** Teleport
- `src/main/embedding/diagramGenerator.ts` — two-step AI diagram generator; `generateExcalidrawDiagram(prompt, db)`: **Step 1 (Plan)** — calls `callWithFallback('diagram_generate', db, ...)` with a system prompt that outputs a structured JSON plan (nodes with id/label/shape/row/col/color, edges with from/to/label); **Step 2 (Render)** — pure TypeScript converts the plan to Excalidraw elements using a fixed grid (`CELL_W=240, CELL_H=160`); generates rectangle/ellipse/diamond shape elements + inline text `containerId` labels + arrow elements with `startBinding`/`endBinding`; no second LLM call (grid math is deterministic); returns `{ elements: string, appState: string }` JSON strings
- `excalidraw:generate` (IPC) — `{ prompt: string }` → `{ elements: string, appState: string } | { error: string }`; calls `generateExcalidrawDiagram()`; feature slot `diagram_generate` (default: `claude-sonnet-4-6`)
- `src/renderer/extensions/ExcalidrawExtension.ts` — TipTap `Node.create` definition for the `excalidraw` atom node; `atom: true, selectable: true, draggable: true`; attributes: `elements` (JSON string, default `'[]'`), `appState` (JSON string, default `'{}'`), `files` (JSON string, default `'{}'`), `previewSvg` (SVG string, default `''`), `drawingHeight` (number|null, persisted via `data-drawing-height`); `addNodeView()` returns `VueNodeViewRenderer(ExcalidrawView)`; registered in `NoteEditor.vue` and `TemplateEditor.vue` extensions arrays; auto-open on creation uses session flag (`requestExcalidrawAutoOpen`) not a node attribute
- `src/renderer/utils/markdown.ts` — shared markdown-to-HTML utility (`markdownToHtml`, `renderInline`, `escapeHtml`); handles headings, bullet/ordered lists, task lists (styled checkboxes), bold/italic/code inline; imported by `TodayView.vue` and `EntityReviewPanel.vue`; also exports **`renderWebLinkChip(title, url)`** — generates `<span class="wizz-web-chip" data-web-url="...">` HTML with an inline globe SVG for clickable web links rendered inside `v-html`; **`WEB_LINK_CHIP_CLASS`** constant (`'wizz-web-chip'`); `renderInline()` handles Markdown links `[label](https://...)` and bare `https?://` URLs via placeholder substitution (`WIZZURL{n}WIZZURL`) before HTML-escaping, then substitutes them back as `renderWebLinkChip()` HTML
- `SettingsModal.vue` — macOS-style two-pane modal with a **tree nav** on the left (category group labels + indented subcategory items) and a single-section right pane; navigation state held in `activeSection` ref (e.g. `'ai:llm'`, `'calendar:sync'`); categories: **AI** (subcategories: LLM Providers, Personalization, AI Features, Transcription, Follow-up), **Actions** (no subcategories), **Calendar** (subcategories: General, Calendar Sync, Attendees), **Debug** (no subcategories); **SINGLE SAVE BUTTON RULE — there is exactly one Save button in the bottom-right footer; no section pane may add its own Save/Submit button**; the footer Save button calls `save()` which persists all settings at once, including: provider cards (`ai-providers:save`), feature chains (saved immediately on change via `ai-feature-models:save`), all `settings:set` key/value pairs, and personalization (`ai_personalization_html/text/entity_ids/note_ids` from `personalizationInputRef` if mounted); **LLM Providers** section: Web Search toggle (`web_search_enabled`), provider cards list via `ai-providers:list`, [+ Add Provider] picker; **AI Features** section: one `FeatureChainEditor` per feature slot (chain changes also save immediately); **Transcription** section: segmented engine picker `ElevenLabs | Deepgram | macOS`, conditional API key / language / diarization fields, System Audio Capture toggle; **Personalization** section: `RichTextInput` for user self-description (supports `@entity` mentions and `[[note]]` links); HTML restored via `setContent()` when the section first becomes visible (watch on `activeSection`); saved via the main footer Save button; **Calendar → General**: slot duration, meeting note title template; **Calendar → Calendar Sync**: source cards (enable/disable, sync-now, edit, delete), Add source button; **Calendar → Attendees**: attendee entity type + name/email field mapping, team entity type + field mapping; **Actions**: renders `GTDSettingsPanel.vue`; **Debug**: save audio toggle, re-embed all button
- `AIProviderCard.vue` — single provider panel; optional props `credentialType?: 'api_key' | 'base_url'`, `credentialDefault?`, `credentialPlaceholder?` control credential UI: `api_key` (default) renders masked password input + show/hide toggle; `base_url` renders plain text input (no masking — URLs are not secrets) and pre-fills from `credentialDefault` on mount; Test/Refresh button calls `ai-providers:fetch-models`; button always enabled for `base_url` providers since URL has a non-empty default; model list grouped by capability (Chat/Image/Embeddings) with max-height scroll and custom checkboxes; Remove provider button with confirmation; exposes `getData(): { apiKey, enabledModelIds, models }` via `defineExpose`
- `FeatureChainEditor.vue` — one row per feature slot; label + description column; chain column with select dropdowns (filtered by capability), `→` arrows, `×` remove buttons, `+ fallback` / `+ Add model` button; emits `change: [{ featureSlot, modelIds }]`
- `ChatSidebar.vue` — fixed right panel (360px) for AI chat; toggled via "Ask Wizz" sidebar button or `Cmd+J`; messages stored in `chatStore` (session-only, no DB); sends `chat:send` IPC with optional `overrideModelId`; header includes model selector (Default + all enabled chat models — "Default" = empty string = use configured chain); **web search globe icon** in header (`Globe` lucide icon, blue tint) — visible when `webSearchEnabled` ref (loaded from `web_search_enabled` setting on mount); clicking emits `open-view('__settings__')` to open Settings; subscribes to `web-search:performed` push → sets `webSearchQuery` ref → shows `WebSearchIndicator` in the loading bubble; `webSearchQuery` cleared when `isLoading` becomes false; renders `[Note: "Title"]` citations as clickable chips; renders **action cards** below assistant messages (`ensured_action_created` → green "Created & linked task", `ensured_action_found` → blue "Linked existing task"); supports **note selection attachments** via `useNoteSelectionPaste` composable — pastes of `NOTE_SELECTION_MIME` data show `NoteSelectionChip` chips above the input and send `noteSelections` in the `chat:send` payload; historical user messages also display `NoteSelectionChip` chips for previously attached selections; click delegate for `[data-web-url]` invokes `shell:open-external`; shows fallback warning when a secondary model was used; emits `open-note`, `open-view`, `close`
- `WebSearchIndicator.vue` — transient in-progress indicator shown inside the loading bubble during `web_search` tool calls; props: `query: string`; renders a pulsing globe SVG + "Searching the web for '{query}'…" (query truncated to 60 chars); fade-in animation reusing `agent-phase-fadein` keyframe; CSS in `style.css` (`.web-search-indicator`, `.web-search-indicator-globe`, `@keyframes web-search-pulse`)
- `src/renderer/stores/chatStore.ts` — module-level reactive state for AI chat: `messages` (`ChatMessage[]` with `role`, `content`, optional `references`, `actions: ExecutedAction[]`, `noteSelections?: NoteSelectionAttachment[]`, and `error`), `isLoading`, `clearMessages()`; exports `ExecutedAction` type (`'ensured_action_created' | 'ensured_action_found'` added for `ensure_action_item_for_task` WIZZ_TOOL); session-scoped (in-memory only)
- `src/renderer/types/noteSelection.ts` — defines `NoteSelectionAttachment` interface (`noteId`, `noteTitle`, `blockStart`, `blockEnd`, `selectedText`) and `NOTE_SELECTION_MIME` constant (`'application/x-wizz-note-selection'`); shared by renderer components and composables
- `src/renderer/utils/noteSelection.ts` — `buildNoteSelectionAttachment(editor, noteId, noteTitle, from, to)`: walks TipTap top-level block nodes overlapping the ProseMirror selection, extracts block-level "line" indices and serialises each block to plain text (preserving task checkboxes, lists, headings); `formatNoteSelectionForPrompt(attachment)`: formats a single selection as a Markdown block with metadata header; `formatNoteSelectionsForPrompt(attachments[])`: wraps multiple formatted blocks in `<note_selections>…</note_selections>` XML for AI context injection
- `src/renderer/composables/useNoteSelectionPaste.ts` — `useNoteSelectionPaste()`: reactive `attachedSelections: Ref<NoteSelectionAttachment[]>`, `onPaste(e)` (returns `true` and appends when clipboard contains `NOTE_SELECTION_MIME` data), `removeSelection(index)`, `clear()`; used by `ChatSidebar` and `AIPromptModal` — called before `useFileAttachment.onPaste` so structured selections take priority
- `NoteSelectionChip.vue` — compact chip component displaying a note selection; props: `attachment: NoteSelectionAttachment`, `removable?: boolean`; shows `AlignLeft` icon, note title, and block range `(blocks N–M)`; emits `remove`; styled via `.wizz-note-selection-chip` global CSS class in `style.css`; used in `ChatSidebar`, `AIPromptModal`, and message history display
- `RichTextInput.vue` — lightweight contenteditable rich-input with `@entity` mention and `[[note-link]]` trigger support (same UX as chat input, without TipTap overhead); public API via `defineExpose`: `getContent(): RichInputContent` (extracts plain text + entity/note IDs), `getHtml(): string` (raw innerHTML for persistence), `setContent(html: string): void` (restores editor from saved HTML, re-applies entity chip colors via `applyAfterTick`), `clear()`, `focus()`, `isEmpty(): boolean`; emits `change`, `submit`, `escape`, `paste`; used in `ChatSidebar` (chat textarea), `AIPromptModal`, and **`SettingsModal` Personalization tab**; `RichInputContent` interface exports `text`, `displayContent`, `mentionedEntityIds`, `mentionedEntities`, `mentionedNoteIds`, `mentionedNotes`, `selections`
- `LucideIcon.vue` — dynamic Lucide icon renderer; accepts `name` (kebab-case, e.g. `'user'`, `'bar-chart-2'`), `size`, `color` props; converts to PascalCase to look up the icon component from `lucide-vue-next`; falls back to `Tag` for unknown names
- `IconPicker.vue` — searchable Lucide icon grid picker (`v-model` stores kebab-case icon name); builds full icon list from `lucide-vue-next` exports at module load; filters by search query; shows up to 96 results; used in `EntityTypeModal`
- `TemplateList.vue` — template list pane (240px); exposes `refresh()`; emits `select: [id]`, `new-template`; click selects template; inline delete confirmation; shown in the Templates view
- `TemplateEditor.vue` — TipTap-based template editor; props: `templateId`; emits `saved: [name: string]`, `loaded: [name: string]`; auto-save 500ms debounce to `templates:update`; includes inline icon picker (via `IconPicker.vue`) and name input; same formatting toolbar as `NoteEditor` minus mention/link extensions; shows a hint about template usage
- `CodeBlockView.vue` — TipTap `VueNodeViewRenderer` component for `codeBlock` nodes; registered via `CodeBlockLowlight.extend({ addNodeView })` in both `NoteEditor` and `TemplateEditor`; renders a header bar (language `<select>` on the right, hide/show toggle on the left when Mermaid is selected) + `<pre><NodeViewContent as="code" /></pre>` + a Mermaid preview pane when `language === 'mermaid'`; **Mermaid mode**: calls `renderMermaid()` (debounced 400 ms) on every `node.textContent` change and on mount; shows rendered SVG, a styled error box on parse failure, or a placeholder when source is empty; **hide-code toggle**: persisted as a `hideCode` boolean TipTap node attribute (survives save/reload); toggle disabled when there is a Mermaid error; `<pre>` uses `v-show` (not `v-if`) so `NodeViewContent` stays mounted for ProseMirror cursor tracking; `CodeBlockLowlight` is extended in both editors to declare the `hideCode` attribute (`parseHTML` reads `data-hide-code`, `renderHTML` writes it only when `true`)
- `ToolbarDropdown.vue` is a reusable dropdown used in the editor toolbar
- `TableContextMenu.vue` — fixed-position right-click context menu for table operations; props: `editor: Editor`, `x: number`, `y: number`; emits `close`; shows 7 base operations (add/delete col/row, delete table) + conditional **Merge cells** (when `CellSelection` spans multiple cells) and **Split cell** (when cursor is in a merged cell); `CellSelection instanceof` check from `@tiptap/pm/tables`; NoteEditor wires `@mousedown` on `.note-body` to prevent right-click from collapsing `CellSelection` before contextmenu fires
- `src/renderer/stores/mentionStore.ts` — module-level reactive state shared between `NoteEditor` and `MentionChip` (bypasses Vue injection isolation in TipTap NodeViews): `entityTrashStatus: reactive(Map<string, boolean>)`, `registerMentionClickHandler`, `fireMentionClick`
- `src/renderer/stores/noteLinkStore.ts` — same pattern for note-links: `noteArchivedStatus: reactive(Map<string, boolean>)`, `registerNoteLinkClickHandler`, `fireNoteLinkClick`
- Path alias: `@` resolves to `src/renderer/`
- Icons: **lucide-vue-next** throughout; entity type icons stored as kebab-case Lucide names (e.g. `'user'`, `'folder'`); built-in seeds migrated from emoji on startup via idempotent UPDATE statements in `schema.ts`
- Sidebar nav: fixed top items (Today, Notes, **Templates**) + dynamic entity type list + fixed bottom items (Actions, Calendar, Search, **Trash**, **Settings**)

### Settings Modal Save Rule — ALWAYS FOLLOW

**`SettingsModal.vue` has exactly one Save button — the one in the bottom-right footer.** No section pane inside the settings modal may add its own Save, Submit, or Apply button. All settings must be collected and persisted via the single `save()` function called by that footer button. If a new settings field is added to any section, wire its value into `save()` — never add an inline save control.

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

### Design System & Styles — ALWAYS FOLLOW

The renderer uses a single flat CSS file (`src/renderer/style.css`) as the source of truth for all design tokens, utility classes, and shared component styles. **Never invent new tokens, colours, or form patterns inline in a component.**

#### CSS design tokens (defined in `:root`)

| Token | Value | Use for |
|-------|-------|---------|
| `--color-bg` | `#1a1a1a` | App / page background |
| `--color-sidebar` | `#161616` | Sidebar background |
| `--color-surface` | `#242424` | Cards, inputs, dropdowns |
| `--color-surface-raised` | `#2c2c2c` | Popovers, tooltips on surface |
| `--color-bg-elevated` | `#2a2a2a` | Floating panels on bg |
| `--color-border` | `#2e2e2e` | All borders / dividers |
| `--color-text` / `--color-text-primary` | `#e8e8e8` | Primary text |
| `--color-text-muted` / `--color-text-secondary` | `#888` | Secondary / placeholder text |
| `--color-accent` / `--color-primary` | `#5b8def` | Accent, focus ring, active state |
| `--color-accent-hover` | `#7aaeff` | Accent hover |
| `--color-danger` | `#ef4444` | Destructive actions, errors |
| `--color-danger-subtle` | `rgba(239,68,68,0.1)` | Danger background tint |
| `--color-danger-border` | `rgba(239,68,68,0.35)` | Danger border tint |
| `--color-success` | `#34d399` | Success / complete states |
| `--color-note` | `#50c0a0` | Note-link chips and accents |
| `--color-hover` | `rgba(255,255,255,0.05)` | Hover background on any surface |

**Rules:**
- Always reference tokens with `var(--color-*)`. Never write raw hex values in component CSS.
- Only `style.css` defines the `:root` block. Never add `--color-*` variables inside a component's `<style scoped>`.
- Extend the token set in `style.css` `:root` when a genuinely new semantic concept is needed; don't create one-off local variables.

#### Shared form utility classes (defined in `style.css`)

Use these classes directly on native elements. Override only what genuinely differs per context via a small scoped rule — never redefine the full property set locally.

| Class | Element | When to use |
|-------|---------|-------------|
| `.form-input` | `<input>` | Any standard text / email / date / number input |
| `.form-select` | `<select>` | Any select dropdown (includes custom chevron SVG) |
| `.form-textarea` | `<textarea>` | Any multi-line text area |
| `.form-checkbox` | `<input type="checkbox">` | Standalone checkbox outside a toggle-row |
| `.form-label` | `<label>` / `<span>` | Field labels above inputs |

**Standard values enforced by the utilities** (do not deviate):
- Background: `var(--color-surface)` (or `var(--color-bg)` for inputs inside modals that sit on a surface)
- Border: `1px solid var(--color-border)`, `border-radius: 6px`
- Padding: `7px 10px` (compact panels may use `4–5px 8px` but keep the radius)
- Focus: `border-color: var(--color-accent)`, no browser default outline
- Placeholder: `color: var(--color-text-muted)`
- Transition: `border-color 0.15s`
- Font: `inherit` (guaranteed by the global element reset)

#### Checkbox / toggle pattern

All checkboxes in the app use a **custom dark-themed checkbox** — `appearance: none` with a hand-drawn checkmark via `::after`. The authoritative implementation lives in:

- **`style.css` `.form-checkbox`** — global utility for standalone use
- **`AIProviderCard.vue` `.toggle-checkbox`** — reference implementation for modal toggles

When adding a new checkbox in any component, copy the scoped `.toggle-checkbox` pattern from `SettingsModal.vue` or use `.form-checkbox` directly. **Never use `accent-color` alone** — it leaves the unchecked state as a native white box in Electron's dark context.

```css
/* Correct pattern for any new checkbox */
.my-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 15px; height: 15px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-surface);
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: background 0.12s, border-color 0.12s;
}
.my-checkbox:checked { background: var(--color-accent); border-color: var(--color-accent); }
.my-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 4px; top: 1px; width: 5px; height: 8px;
  border: 1.5px solid #fff;
  border-top: none; border-left: none;
  transform: rotate(45deg);
}
```

#### `color-scheme: dark`

`body { color-scheme: dark }` is set globally. This forces Chromium/Electron to render **all** native form widgets (select popups, date pickers, number spinners, scrollbars) in their dark system variant. Do not remove it.

#### Danger / destructive styling

Use the three danger tokens; never write raw red hex values:

```css
color: var(--color-danger);              /* text / icon */
background: var(--color-danger-subtle);  /* button/row hover bg */
border-color: var(--color-danger-border); /* button/row hover border */
```

A "danger button hover" pattern:
```css
.btn-delete:hover {
  background: var(--color-danger-subtle);
  color: var(--color-danger);
  border-color: var(--color-danger-border);
}
```

#### Where styles live

| Situation | Where to put it |
|-----------|----------------|
| Token (color, spacing constant) | `style.css` `:root` |
| Class used by ≥2 components | `style.css` as a global utility |
| Class used only inside one component | `<style scoped>` in that component |
| Override of a global utility | Small scoped rule; reference same tokens |
| `:deep()` targeting a global class | **Forbidden** — edit `style.css` instead |
| Duplicate of an existing global class | **Forbidden** — use the existing class |

### Abstraction, Reusability & Consistency Rule — ALWAYS FOLLOW, FOR EVERY CHANGE

**This is not a chip-specific rule. It applies to every change, big or small — logic, styles, types, IPC helpers, AI prompt builders, click handlers, anything.**

The default decision order is:
1. **Find** — search the codebase for an existing abstraction that covers the need (composable, utility, component, constant, CSS class).
2. **Extend** — if it almost fits, extend it rather than duplicating it.
3. **Create new, make it reusable immediately** — if nothing exists, build it as a shared abstraction from day one; never write something inline that a second surface will need.

Concrete rules:
- If a pattern already exists (file attachment, `@mention`, `[[` note-link, chip display, dropdown picker, open-mode click handling, AI context formatting, form input styling…), use it — never reinvent it inline.
- Shared logic → composable (e.g. `useFileAttachment`, `useInputMention`, `useInputNoteLink`, `useEntityChips`).
- Shared visual element rendered via Vue template → component (e.g. `AttachmentBar`, `TaskAttributeChip`, `LucideIcon`).
- Shared HTML emitted via `v-html` → generator function in a utility module (e.g. `renderEntityChip`, `renderNoteChip` in `markdown.ts`).
- Shared CSS → global `style.css`; never duplicate rules with `:deep()` in individual components.
- Shared form elements → use `.form-input`, `.form-select`, `.form-textarea`, `.form-checkbox`, `.form-label` from `style.css`; override only context-specific values in scoped styles.
- Shared colours → always `var(--color-*)` tokens; never raw hex. Add new tokens to `style.css` `:root` if the semantic concept is new.
- Shared types → exported from the canonical source, never redeclared locally.
- Shared constants (class names, string keys, slot identifiers) → exported constants, never hardcoded strings in two places.
- Click-handler selectors for `v-html` content → data-attribute selectors (`[data-entity-name]`), never class selectors (decouples HTML structure from behaviour).
- Before writing any new pattern, **search first**. Divergence between surfaces is a bug, not a style choice.

### Inline Reference Chip Rule — ALWAYS FOLLOW

**All entity and note chips rendered inside `v-html` content (AI chat, daily briefs, entity reviews, etc.) MUST use the canonical classes and helpers. Never invent component-local chip classes or HTML.**

| What | Where | Rule |
|------|-------|------|
| Generate entity chip HTML | `renderEntityChip(id?, name)` in `src/renderer/utils/markdown.ts` | Single source of truth |
| Generate note chip HTML | `renderNoteChip(id?, title)` in `src/renderer/utils/markdown.ts` | Single source of truth |
| Generate web link chip HTML | `renderWebLinkChip(title, url)` in `src/renderer/utils/markdown.ts` | Single source of truth |
| CSS class — entity chip | `.wizz-entity-chip` | Defined in `src/renderer/style.css` only |
| CSS class — note chip | `.wizz-note-chip` | Defined in `src/renderer/style.css` only |
| CSS class — web link chip | `.wizz-web-chip` | Defined in `src/renderer/style.css` only |
| Apply type color + icon | `useEntityChips` composable (`applyAfterTick` / `applyToElement`) | Called after every DOM update that could contain chips |
| Click delegation | `target.closest('[data-entity-name]')` / `target.closest('[data-note-title]')` / `target.closest('[data-web-url]')` | Use data-attribute selectors, never class selectors |

- **Do not** add `:deep(.some-chip)` CSS in any component — edit `style.css` instead.
- **Do not** add additional selectors to `useEntityChips.ts` — if a new surface needs chip styling, use the same class and call `applyAfterTick`.
- The `ENTITY_CHIP_CLASS` and `NOTE_CHIP_CLASS` constants in `markdown.ts` are the authoritative class-name strings. Import them wherever the string is referenced.

### Key Design Decisions

- **Local-first**: All data on-device in SQLite; no cloud backend currently
- **Electron IPC — `An object could not be cloned`**: Electron's `ipcRenderer.invoke` / `ipcMain.handle` uses `v8.serialize` (Node structured clone), which is stricter than the browser's `structuredClone`. It rejects anything that isn't a plain serializable value and throws `Error: An object could not be cloned`. Common causes and fixes:
  - **Vue reactive Proxies** — objects stored in `ref<T[]>()` or `reactive()` are wrapped in `Proxy`; `[...reactiveArray]` copies the array shell but each element is still a Proxy. Fix: `array.map(item => ({ ...item }))` to produce plain objects at the element level.
  - **Class instances** — instances of custom classes (anything with a non-Object prototype) are not cloneable. Fix: convert to a plain `{}` literal before sending.
  - **Functions, Symbols, WeakMap/WeakSet, DOM nodes** — none are cloneable. Never include them in IPC payloads.
  - **General rule**: every value passed to `window.api.invoke()` or returned from `ipcMain.handle()` must be a plain JSON-compatible value (primitives, plain `{}` objects, plain `[]` arrays). When in doubt, serialize with `JSON.parse(JSON.stringify(value))` as a defensive measure.
- **Embedding pipeline** (`src/main/embedding/`): `chunker.ts` splits `body_plain` into ~1600-char sentence-bounded chunks with ~200-char overlap; `embedder.ts` uses `callWithFallback('embedding', db, ...)` to call the configured embedding model (default: OpenAI `text-embedding-3-small`, 1536d); `summarizer.ts` uses slot `note_summary` for L2 note summarization; `ner.ts` uses slot `ner` for entity detection; `actionExtractor.ts` uses slot `action_extract` (caps at 20 per note); `dailyBrief.ts` uses slot `daily_brief`; `chat.ts` uses slot `chat` for AI chat, `query_expand` for query expansion, `rerank` for search re-ranking, `inline_ai` for inline AI generation; `pipeline.ts` orchestrates fire-and-forget L1+L2+NER+Actions pipeline after every note save — all tasks run concurrently in `Promise.all`; NER upserts `auto_detected` rows in `entity_mentions`; action extraction replaces `ai_extracted` rows in `action_items` and pushes `note:actions-complete` to renderer; **`kmeans.ts`** — pure TypeScript K-means++ clustering; **`clusterBuilder.ts`** — L3 pipeline using slot `cluster_summary`; **`scheduler.ts`** — `scheduleNightlyClusterBatch()` called at startup; vec0 tables (`chunk_embeddings`, `summary_embeddings`, `cluster_embeddings`) store FLOAT[1536] BLOBs; L1 requires `embedding` chain; L2+ requires `note_summary` chain; all slots gracefully skip when no model is configured
- **Local web search pipeline** (`src/main/web/`): `searcher.ts` — `searchDDG(query, maxResults)` fetches `html.duckduckgo.com/html/` directly with browser-like headers (avoids anti-bot blocks) and parses results with `linkedom` (`parseHTML`); decodes DDG redirect URLs (`//duckduckgo.com/l/?uddg=ENCODED_URL`) to real destinations; returns `SearchResult[]` (title, url, snippet); `fetcher.ts` — `fetchPage(url)` with 8s timeout, 512 KB cap, browser UA, returns `string | null`; `extractor.ts` — `extractMarkdown(html, url)` using `linkedom` + `@mozilla/readability` + `turndown`; 4000 char cap; returns `string | null`; `pipeline.ts` — `searchAndRead(query, maxResults)` orchestrates all three in parallel, returns `WebPageResult[]`; `index.ts` — re-exports public API; used by `executeWebSearchTool()` in `chat.ts`; **why linkedom over jsdom**: `jsdom@28` depends on `html-encoding-sniffer` → `@exodus/bytes` (ESM-only), which crashes Electron's CJS main process with `ERR_REQUIRE_ESM`; `linkedom` is pure CJS with no native binaries
- **Multi-provider AI routing** (`src/main/ai/`): `featureSlots.ts` — `FEATURE_SLOTS` registry (12 slots: `chat`, `note_summary`, `ner`, `action_extract`, `inline_ai`, `daily_brief`, `cluster_summary`, `query_expand`, `rerank`, `meeting_summary`, `embedding`, `entity_review`) + `DEFAULT_CHAINS`; `modelRouter.ts` — `resolveChain(slot, db)` reads `ai_feature_models` + `ai_models` + `ai_providers`, falls back to `DEFAULT_CHAINS`; `callWithFallback(slot, db, fn)` tries each model in order, logs warnings on failure, throws `AggregateError` if all fail; `registry.ts` — `PROVIDER_DEFS` (Anthropic/OpenAI/Gemini/**Ollama**), `getAdapter(id)`, `getProviderDef(id)`; `ProviderDef` interface has optional `credentialType?: 'api_key' | 'base_url'`, `credentialDefault?: string`, `credentialPlaceholder?: string` — used by the Settings UI to render URL inputs vs masked key inputs; `providers/` — `anthropic.ts`, `openai.ts`, `gemini.ts`, **`ollama.ts`** each implement `ProviderAdapter` (`fetchModels`, `chat`, optional `embed`); **Ollama** stores its base URL (e.g. `http://localhost:11434`) in the `api_key` column — no real auth key required; `ollamaAdapter.fetchModels(baseUrl)` calls `GET /api/tags`; `ollamaAdapter.chat(params, baseUrl)` uses the `openai` npm SDK pointed at `${baseUrl}/v1` with dummy key `'ollama'`; Ollama models use `max_tokens` (not `max_completion_tokens`); Phase 1: chat only — embedding deferred due to non-1536 vector dimensions; DB tables: `ai_providers` (id, api_key, enabled), `ai_models` (id, provider_id, label, capabilities JSON, enabled), `ai_feature_models` (feature_slot, position, model_id); `ai-providers:list` IPC response includes `credentialType`, `credentialDefault`, `credentialPlaceholder` per provider so `AIProviderCard.vue` adapts its UI; **`personalization.ts`** — `getPersonalizationPreamble(db): PersonalizationContext` reads `ai_personalization_text/entity_ids/note_ids` settings, truncates preamble to 2000 chars, returns safe empty defaults if unconfigured; called by `sendChatMessage()`, `generateInlineContent()`, `generateDailyBrief()`, `generateEntityReview()`, and `generateMergedNote()` (postProcessor); injected as `\n\n## About the user\n{preamble}` in every system prompt; `entityIds` merged into entity context resolution in `chat:send` IPC handler; `noteIds` prepended to `pinnedNotes` in `chat:send` IPC handler
- **Entity Recurring Reviews** (`src/main/entity/`): `reviewGenerator.ts` — gathers entity context (fields, notes mentioning the entity, non-cancelled action items, calendar events) for a configurable period window; builds a type-aware prompt (entity type name + field schema drive tone: Person → relationship/performance focus, Project → health/blockers, Team → dynamics, Decision → outcome, OKR → progress); calls `callWithFallback('entity_review', db, ...)` and persists result to `entity_reviews` table; pushes `entity-review:complete` to renderer; `reviewScheduler.ts` — background scheduler (30-minute tick) that checks each `review_enabled` entity type against its frequency/day/time config and a minimum 22-hour cooldown per entity; generates reviews for all non-trashed entities of due types; called via `scheduleEntityReviews()` at startup in `src/main/index.ts`; per-type mutex prevents concurrent runs; all slots gracefully skip when no model configured
- **sqlite-vec loading**: `sqliteVec.load(db)` called after schema init in `db/index.ts`; both `sqlite-vec` and `sqlite-vec-darwin-arm64` (and other platform packages) are in `asarUnpack` so the dylib resolves to the real filesystem path in packaged app; graceful fallback on load failure (warning log, app continues without semantic search)
- **Chunked note storage**: `note_chunks` table stores L1 raw chunks (layer=1), L2 note summaries (layer=2), L3 cluster summaries (layer=3) for a future 3-layer embedding hierarchy (raw → summary → cluster) for semantic search
- **FTS5** is already wired up on `notes` for full-text search
- Entity graph: `entities` + `entity_mentions` + `note_relations` form a knowledge graph linking notes to people/projects/teams/decisions/OKRs; `entity_mentions` has two row types: `mention_type='manual'` (from TipTap `@mention` chips, rebuilt on every save) and `mention_type='auto_detected'` (from NER pipeline, `confidence` 0.0–1.0, rebuilt fire-and-forget after save); `entities:get-mention-count` counts `DISTINCT note_id` so both types are counted but deduplicated per note
- **Trash pattern**: entities use `trashed_at` (soft-delete); notes use `archived_at` (soft-delete); both have restore and delete-forever actions; `TrashView` in sidebar manages both; trashing from the list triggers a two-step confirmation flow when the item is linked/mentioned (entities: `entities:get-mention-count`; notes: `notes:get-link-count`); restore updates the module-level reactive status map (`entityTrashStatus` / `noteArchivedStatus`) so chips update without reloading notes; `closePanesForContent` is called on trash so open panes close immediately
- **Reactive mention chips**: `entityTrashStatus` (module-level `reactive(Map)`) drives chip appearance without re-loading notes — set on note load, on trash/restore anywhere in the app
- **Tab/pane system**: `tabStore` holds all content navigation state; `tabs` is a global (not per-view) array of `Tab` objects each with one or more `ContentPane`s; `Shift+click` adds a pane to the current tab (split view), `Cmd+click` opens a new tab; pane titles are updated on save via `updatePaneTitle`; trashing an entity closes all panes for it via `closePanesForContent`
- **Mic monitor** (`src/main/mic/monitor.ts`): spawns `resources/MicMonitor` Swift binary as a child process; reads JSON events line-by-line from stdout; on state change pushes `mic:active` / `mic:inactive` to renderer via `pushToRenderer()`; exports `startMicMonitor()`, `stopMicMonitor()`, `getMicStatus()`; auto-restarts on crash (max 5 attempts, 3s backoff); graceful no-op if binary missing. Binary path: `resources/MicMonitor` (dev) / `process.resourcesPath/MicMonitor` (prod). Build: `npm run build:swift` (compiles `swift/MicMonitor/Sources/main.swift` with `swiftc`). Binary is in `extraResources` in electron-builder config and `.gitignore`d.
- **Transcription pipeline** (`src/main/transcription/`): Three backends selected by `transcription_model` setting:
  - **ElevenLabs Scribe v2** (`elevenlabs`): two sub-modes toggled by `elevenlabs_diarize` setting (Settings → AI → ElevenLabs → Speaker Diarization):
    - **Realtime** (default, off): WS `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`; PCM 16kHz Int16 streamed from `ScriptProcessorNode`; live transcript via `partial_transcript`/`committed_transcript`; no speaker labels
    - **Batch** (on): no WebSocket; PCM chunks buffered in `batchAudioChunks[]`; on stop WAV assembled via `buildWavBuffer()` (16kHz mono Int16 header) and POSTed to `POST https://api.elevenlabs.io/v1/speech-to-text` with `model_id=scribe_v2&diarize=true`; `words.speaker_id` strings mapped to sequential ints → `[Speaker N]: text` labeled transcript; up to 48 speakers; no live preview
    - Both sub-modes return `audioFormat:'pcm'` to renderer when `system_audio_capture='false'`; return `audioFormat:'system-audio'` when system audio is enabled (AudioCapture.app provides PCM chunks directly — renderer captures nothing)
  - **Deepgram Nova-3** (`deepgram`): WS `wss://api.deepgram.com/v1/listen` with `nova-3`, `punctuate`, `smart_format`, `diarize`; auth via `Authorization: Token`; raw WebM/Opus binary; renderer uses `MediaRecorder` 250ms chunks → returns `audioFormat:'webm'`; **speaker diarization**: `words` array parsed per final result → speaker segments accumulated as `[{speakerId, text}]`; on stop, consecutive same-speaker segments merged into `[Speaker N]: text` blocks; when `system_audio_capture='true'` opens `openDeepgramSocketPcm()` with `encoding=linear16&sample_rate=16000` and feeds PCM buffers from AudioCapture.app → returns `audioFormat:'system-audio'`
  - **macOS SFSpeechRecognizer** (`macos`): spawns Swift `Transcriber.app` binary (offline via online Apple Speech servers); binary captures mic directly → returns `audioFormat:'none'`
  - **System Audio Capture** (`system_audio_capture` setting `'true'|'false'`): when enabled for ElevenLabs or Deepgram, spawns `AudioCapture.app` (`src/main/transcription/audioCapture.ts`) alongside the cloud WebSocket; AudioCapture.app uses Core Audio Taps (`AudioHardwareCreateProcessTap`, macOS 14.2+) for all-process system audio + `AVAudioEngine` for mic, mixes both to PCM Int16 16kHz mono, streams as base64 JSON chunks; returns `audioFormat:'system-audio'` → renderer skips `getUserMedia`; `stopAudioCapture()` called in `cleanupSession()`; requires `NSScreenCaptureUsageDescription` in Info.plist
  - `postProcessor.ts` — after stop: if transcript has `[Speaker N]` labels and ≥2 calendar event attendee names are known, Claude Haiku maps speaker IDs → attendee names (replaced in transcript before storage); Claude Haiku meeting summary replaces note body; raw transcript (with speaker names) stored in `note_transcriptions.raw_transcript`; `scheduleEmbedding(noteId)`, pushes `transcription:complete`
- **MeetingPrompt.vue**: fixed bottom-right overlay; listens to `mic:active` / `mic:inactive` push events; shows after 5s debounce of continuous mic activity; three actions: **Transcribe** (sends `meeting-prompt:transcribe` with `{ eventId }` to main → creates/finds linked note → pushes `transcription:open-note` to main renderer), **Always transcribe** (saves `auto_transcribe_meetings=true` setting then triggers same), **Skip**; auto-transcribes on `mic:active` if `auto_transcribe_meetings=true` in settings; auto-dismisses on `mic:inactive`
- **NoteEditor.vue** transcription additions: "Start Transcription" / "Stop" button in the meeting context header; `startTranscription()` branches on `audioFormat`; **Transcriptions panel** at bottom of note (shown when `linkedCalendarEvent` is set AND recording or sessions exist): shows live text while recording + all stored sessions as collapsible rows (timestamp + duration, AI summary, expandable raw transcript); `loadTranscriptions()` called after `loadNote` and on `transcription:complete`; on stop, `expandedTranscriptIds` is reset so the new session auto-expands
- `src/renderer/stores/transcriptionStore.ts` — `pendingAutoStartNoteId: ref<string | null>` — set by App.vue on `transcription:open-note`, cleared by NoteEditor after auto-start; same module-level pattern as `mentionStore.ts`
- **CalendarView.vue** — full-screen calendar view; 4 view modes: day, work-week (Mon–Fri), week (Sun–Sat), month; time grid (7am–9pm, 64px/hour) for non-month views; click empty slot → `MeetingModal` (create); click local event → `MeetingModal` (edit); click synced event → `SyncedEventPopup` (read-only info); synced events shown in teal with cloud icon; drag/resize blocked on synced events; subscribes to `calendar-sync:complete` push → reloads visible range; prev/next/today navigation; emits `open-note`
- **MeetingModal.vue** — create/edit meeting modal; fields: title, date, start/end time, attendees (add/remove chips), **Meeting Notes** section (edit mode only: shows linked note with open/unlink, or "Create Meeting Notes" dashed button + "attach existing note" search input); two-step delete confirm; calls `calendar-events:create` or `calendar-events:update` on save; `calendar-events:delete` on delete; `CalendarEvent` type exported from here (id: number, external_id, **source_id** (non-null = synced/read-only), title, start_at, end_at, attendees JSON string, linked_note_id, linked_note_title); attendee items type: `{ name, email, entity_id? }`; on mount loads `attendee_entity_type_id/name_field/email_field` settings — if all set, attendee input switches to entity search mode; "Create Meeting Notes" calls `notes:create` with title from `meeting_note_title_template`, then `calendar-events:update` to link it, emits `open-note` then `saved`; note search input (calls `notes:search`) selects an existing note to attach via `calendar-events:update`
- **SyncedEventPopup.vue** — read-only info popup for synced events; shows title, date/time, attendees, linked note chip (open/unlink via `calendar-events:update`) or note search input to link one; source badge (loads source name via `calendar-sources:list`); fixed position near click, clamped to viewport; click-outside to close; emits `open-note` (all 3 modes), `note-linked`, `note-unlinked` (parent updates its `events` array in-place so popup stays fresh)
- **CalendarSourceModal.vue** — add/edit calendar source modal (z-index 1100); step 1: provider picker (Apps Script active, others "coming soon"); step 2: name, sync interval, Web App URL + "Test Connection" (calls `calendar-sources:verify`); on verify success shows connected email + calendar checkboxes; collapsible setup instructions with copyable Apps Script code; calls `calendar-sources:create` or `calendar-sources:update`
- `calendar-events:list` — `{ start_at, end_at }` → `CalendarEvent[]` (with `linked_note_title` via LEFT JOIN, **source_id** included via `ce.*`); date range inclusive start, exclusive end, ordered by `start_at`
- `calendar-events:create` — `{ title, start_at, end_at, attendees?, linked_note_id? }` → full row; attendees stored as JSON string
- `calendar-events:update` — `{ id, title?, start_at?, end_at?, attendees?, linked_note_id?, transcript_note_id? }` → `{ ok }`; dynamic SET clause
- `calendar-events:delete` — `{ id }` → `{ ok }`; hard-delete
- `calendar-events:get-by-note` — `{ note_id }` → `CalendarEvent & { linked_note_title }` | null; finds the event that links to this note (used by NoteEditor to show meeting context header)
- **Calendar Sync IPC** (`src/main/calendar/sync/`):
  - `calendar-sources:list` → `CalendarSource[]`
  - `calendar-sources:create` — `{ provider_id, name, config, sync_interval_minutes }` → `CalendarSource`
  - `calendar-sources:update` — `{ id, name?, config?, enabled?, sync_interval_minutes? }` → `{ ok }`; `config` passed as `Record<string,string>`, handler JSON-stringifies internally
  - `calendar-sources:delete` — `{ id }` → `{ ok }`; hard-deletes source and its synced events without linked notes
  - `calendar-sources:verify` — `{ provider_id, config }` → `VerifyResult` (`{ ok, displayName?, calendars?, error? }`); no side-effects
  - `calendar-sources:sync-now` — `{ id }` → `{ ok, count }`; runs `syncSource()` immediately
  - `calendar-sources:get-script` — `{ provider_id? }` → `{ source: string, instructions: string[] }`; returns script source + instructions for the given provider (`google_apps_script` default, `google_drive_csv` also supported)
  - `calendar-sync:complete` (push) → `{ sourceId: string, count: number }`; fired after each successful sync
  - `calendar-sync:error` (push) → `{ sourceId: string, message: string }`; fired on sync failure
- **Calendar Sync architecture**: `provider.ts` — `CalendarProvider` interface (`verify`, `fetchEvents`), `ExternalEvent`, `VerifyResult` types; `registry.ts` — provider map + `getProvider(id)`; `providers/googleAppsScript.ts` — Google Apps Script provider (fetch-based, no OAuth); `providers/googleDriveCsv.ts` — Google Drive CSV provider: Apps Script on Workspace account writes a CSV to a shared Drive folder, Wizz fetches and parses it via public download URL (config key: `fileUrl`); includes `DRIVE_CSV_SCRIPT_SOURCE` + `DRIVE_CSV_INSTRUCTIONS` constants; built-in RFC 4180 CSV parser; `engine.ts` — `syncSource(db, source)`: upserts via compound `external_id` (`{sourceId}:{providerEventId}`), purges stale events (preserves those with `linked_note_id`), updates `last_sync_at`; `scheduler.ts` — `startCalendarSyncScheduler()`: setInterval 60s, per-source interval check, mutex via `Set<sourceId>`; called from `src/main/index.ts` at startup alongside `scheduleNightlyClusterBatch`; `calendar_events.source_id` (nullable FK to `calendar_sources`) distinguishes synced events from local; current migrations: `0003` (`recurrence columns`), `0004` (`recurrence_instance_date`), `0005` (`calendar_sources` table + `source_id` column on `calendar_events`)
- `mic:active` (push) → `{ deviceName: string | null, timestamp: string }`; `mic:inactive` (push) → same; `mic:status` (invoke) → `{ isActive: boolean }`
- Transcription IPC (registered in `src/main/transcription/session.ts`):
  - `transcription:start` (invoke) — `{ noteId, eventId }` → `{ ok, audioFormat?, error? }`; routes by `transcription_model` setting: `'elevenlabs'` → ElevenLabs WS → `audioFormat:'pcm'`; `'deepgram'` → Deepgram WS → `audioFormat:'webm'`; `'macos'` → Swift binary → `audioFormat:'none'`; records `sessionStartedAt` for all backends
  - `transcriptions:list` (invoke) — `{ noteId }` → `StoredTranscription[]` sorted newest first; each row: `{ id, note_id, started_at, ended_at, raw_transcript, summary }`
  - `transcription:stop` (invoke) — → `{ ok }`; stops active backend, triggers post-processing in `postProcessor.ts`
  - `transcription:audio-chunk` (send) — `ArrayBuffer`; one-way; ElevenLabs: base64 JSON wrapped; Deepgram: raw binary; no-op for Swift; no-op when `usingSystemAudio=true` (AudioCapture.app provides audio directly)
  - `transcription:status` (invoke) — → `{ isTranscribing, noteId }`
  - `transcription:partial` (push) — `{ text, isFinal }`; live transcript updates from all backends
  - `transcription:complete` (push) — `{ noteId }`; post-processing done, note updated with transcript summary
  - `transcription:error` (push) — `{ message }`; error during session
  - `transcription:open-note` (push) — `{ noteId, eventId, autoStart }` from `meetingWindow.ts` → main renderer; triggers note open + optional auto-start
- **Swift Transcriber binary** (`swift/Transcriber/Sources/main.swift`): SFSpeechRecognizer offline fallback; uses `SFSpeechRecognizer()` with no locale arg (always uses `Locale.current` = macOS system language); `requiresOnDeviceRecognition` intentionally NOT set (uses online Apple Speech servers; setting it true fails with "Siri disabled" if Siri is off); emits JSON lines (`ready`, `partial`, `error`) on stdout; graceful SIGTERM with 5s wait for final result; packaged as `.app` bundle (`resources/Transcriber.app/Contents/MacOS/Transcriber` + `Contents/Info.plist`) required by macOS 26 TCC for `NSSpeechRecognitionUsageDescription` lookup; built with `npm run build:transcriber`; managed by `src/main/transcription/swiftTranscriber.ts`
- **Swift AudioCapture binary** (`swift/AudioCapture/Sources/main.swift`): Core Audio Taps system audio capture; macOS 14.2+ only; uses `CATapDescription()` + `AudioHardwareCreateProcessTap` for all-process output tap, discovers tap's virtual device by diffing device list before/after creation, points a second `AVAudioEngine` at that device via `kAudioOutputUnitProperty_CurrentDevice` on inputNode's audioUnit, uses separate `AVAudioEngine` for mic (default device); mixes both streams at 16kHz mono Float32 (additive, ×0.6 attenuation to prevent clipping), emits base64 JSON chunks every 256ms (`audio_chunk`), SIGTERM → `AudioHardwareDestroyProcessTap` + exit 0; requires `NSScreenCaptureUsageDescription` + `NSMicrophoneUsageDescription`; bundled as `resources/AudioCapture.app`; built with `npm run build:audiocapture`; managed by `src/main/transcription/audioCapture.ts`; `settings` key: `system_audio_capture` (`'true'|'false'`)
- Context isolation + sandbox enabled; no Node integration in renderer
