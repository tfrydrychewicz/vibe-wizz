# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Update this file whenever you complete a commitable increment** — reflect any new IPC channels, components, architectural decisions, or completed phase checklist items from DESIGN.md.

## Commands

```bash
npm run dev        # Start Electron app in dev mode with Vite HMR
npm run build      # Bundle with electron-vite and create macOS DMG
npm run typecheck  # Run vue-tsc + tsc for both renderer and main/preload
npm run rebuild    # Rebuild native modules (better-sqlite3) after Node/Electron version changes
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
- `notes:delete` is a soft-delete (sets `archived_at`); `notes:restore` clears `archived_at`; `notes:delete-forever` replaces all `[[noteLink]]` nodes in other notes' bodies with plain text of the note title, cleans up `note_relations`, then hard-deletes
- `notes:get-link-count` — `{ id }` → `{ count }`: count of distinct notes that `[[link]]` to this note (from `note_relations`); used for trash confirmation in `NoteList` and delete-forever confirmation in `TrashView`
- `entities:delete` is a soft-delete (sets `trashed_at`, returns `{ ok, mentionNoteCount }`); `entities:restore` clears `trashed_at`; `entities:delete-forever` replaces all `@mention` nodes in note bodies with plain text before hard-deleting
- `entities:get-mention-count` — `{ id }` → `{ count }`: count of distinct notes mentioning the entity (from `entity_mentions`)
- `entities:get-trash-status` — `{ ids: string[] }` → `Record<string, boolean>`: batch check which entity IDs are currently trashed
- `trash:list` — returns `{ notes: [{id, title, archived_at}], entities: [{id, name, trashed_at, type_id, type_name, type_icon, type_color}] }`
- `notes:create` accepts optional `{ title?, body?, template_id? }` params (defaults to `'Untitled'` blank note); when `template_id` is given, the template's body is copied in
- `templates:create/update` — `{ name, icon, body }` — templates stored in `note_templates` table; `icon` is a kebab-case Lucide name; `body` is TipTap JSON
- `notes:search` — `{ query }` → `[{ id, title }]`: up to 20 non-archived notes matching title (LIKE); used by `[[` note-link suggestion
- `notes:get-archived-status` — `{ ids: string[] }` → `Record<string, boolean>`: batch check which note IDs are archived
- `notes:update` now syncs both `entity_mentions` and `note_relations` after every save: `entity_mentions` rebuilt from `mention` nodes; `note_relations` (`relation_type = 'references'`) rebuilt from `noteLink` nodes
- `notes:list` returns only non-archived notes sorted by `updated_at DESC`; `entities:list` and `entities:search` exclude trashed entities
- `entities:list` takes `{type_id}` and returns non-trashed entities sorted by name
- `entities:search` takes `{query}` and returns up to 20 non-trashed entities across all types matching the name (LIKE)
- `entity-types:delete` blocks deletion of built-in types (person, project, team, decision, okr)
- `settings:get` — `{ key }` → stored value string or null; `settings:set` — `{ key, value }` → upserts; used for OpenAI API key storage (`openai_api_key`)
- `notes:update` triggers `scheduleEmbedding(id)` fire-and-forget after save (no await); generates L1 chunk embeddings in background if sqlite-vec is loaded and API key is configured
- `notes:semantic-search` — `{ query }` → `[{ id, title, excerpt: string | null }]` (up to 15 notes): embeds the query via OpenAI and runs KNN on `chunk_embeddings` (deduped by note); falls back to FTS5 full-text search if vec not loaded or no API key
- Migration on startup: `ALTER TABLE entities ADD COLUMN trashed_at TEXT` (idempotent try/catch)
- Dev DB: `wizz.dev.db`, Prod DB: `wizz.db` — both in Electron's `userData` directory

### Renderer / UI

- `App.vue` shell: sidebar with fixed nav items (Today, Notes, **Templates**) + **dynamic entity type list** (loaded from DB) + fixed items (Actions, Calendar, Search, Trash)
  - Entity type nav is populated from `entity-types:list` on mount; routes `activeView` to entity type IDs
  - "New entity type" button in sidebar opens `EntityTypeModal`
  - Main area uses `tabStore` for multi-tab/multi-pane content; `activeNoteId`/`activeEntityId` are **computed** from `activePane` (not stored as refs)
  - Notes and entity views share the same tab/pane content area on the right; clicking items in the left list opens them in the active pane; `Shift+click` opens a new pane; `Cmd+click` opens a new tab
  - `noteTemplates` loaded on mount and passed to `NoteList`; refreshed after every `onTemplateSaved`; used to populate the "New Note" template dropdown
- `src/renderer/stores/tabStore.ts` — tab/pane state for the content area: `OpenMode` (`'default' | 'new-pane' | 'new-tab'`), `ContentPane` (`{ id, type, contentId, typeId?, title }`), `Tab` (`{ id, panes, activePaneId }`); exports `tabs`, `activeTabId`, `activeTab`, `activePane`, `openContent`, `closePane`, `closeTab`, `setActiveTab`, `setActivePaneInTab`, `updatePaneTitle`, `closePanesForContent`
- `TabBar.vue` — horizontal tab bar rendered above the panes area when ≥2 tabs are open; each tab shows the active pane's title and a close button; emits `set-active-tab`, `close-tab`
- `NoteList.vue` — note list pane (240px); exposes `refresh()` via `defineExpose`; accepts optional `templates` prop (`{ id, name, icon }[]`); emits `select`, `open-new-pane`, `open-new-tab`, `new-note`, `new-note-from-template: [templateId]`, `trashed`; click handler checks `e.metaKey`/`e.shiftKey` to pick mode; when templates are present the "New Note" button shows a dropdown (blank note + template list); trash button triggers two-step flow (link count check → confirmation overlay → `notes:delete`); sets `noteArchivedStatus.set(id, true)` after archiving; emits `trashed` so `App.vue` can call `closePanesForContent`
- `NoteEditor.vue` uses **TipTap** (ProseMirror-based) for rich text editing with auto-save (500ms debounce); emits `saved: [title: string]` after each successful save; supports `@` entity mentions and `[[` note-links; both use `@tiptap/extension-mention` (renamed `noteLink` for the second instance) + `VueNodeViewRenderer`; on note load, fetches trash/archived status and populates `entityTrashStatus`/`noteArchivedStatus`; emits `open-entity: [{ entityId, typeId, mode: OpenMode }]`, `open-note: [{ noteId, title, mode: OpenMode }]`
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
- `SearchView.vue` — full-screen semantic search view (shown when sidebar Search is active); debounced text input (300ms); calls `notes:semantic-search`; shows note title + matching chunk excerpt per result; click/Shift+click/Cmd+click open modes; gracefully degrades to FTS when no API key
- `SettingsModal.vue` — simple settings modal (opened from sidebar Settings button); password input for OpenAI API key with show/hide toggle; loads current key on mount via `settings:get`; saves via `settings:set`
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
- **Embedding pipeline** (`src/main/embedding/`): `chunker.ts` splits `body_plain` into ~1600-char sentence-bounded chunks with ~200-char overlap; `embedder.ts` lazy-initialises an OpenAI client (text-embedding-3-small, 1536d) keyed by API key from `settings`; `pipeline.ts` orchestrates fire-and-forget chunking + embedding + storage after every note save; vec0 tables (`chunk_embeddings`, `summary_embeddings`, `cluster_embeddings`) store FLOAT[1536] embeddings as BLOBs; `note_chunks.id` (INTEGER PRIMARY KEY AUTOINCREMENT) = `chunk_embeddings.rowid`; vec0 has NO ON DELETE CASCADE — `pipeline.ts` deletes from `chunk_embeddings` before `note_chunks`; `isVecLoaded()` exported from `db/index.ts` — all embedding paths return early if false
- **sqlite-vec loading**: `sqliteVec.load(db)` called after schema init in `db/index.ts`; both `sqlite-vec` and `sqlite-vec-darwin-arm64` (and other platform packages) are in `asarUnpack` so the dylib resolves to the real filesystem path in packaged app; graceful fallback on load failure (warning log, app continues without semantic search)
- **Chunked note storage**: `note_chunks` table stores L1 raw chunks (layer=1), L2 note summaries (layer=2), L3 cluster summaries (layer=3) for a future 3-layer embedding hierarchy (raw → summary → cluster) for semantic search
- **FTS5** is already wired up on `notes` for full-text search
- Entity graph: `entities` + `entity_mentions` + `note_relations` form a knowledge graph linking notes to people/projects/teams/decisions/OKRs; `entity_mentions` is now kept in sync on every note save
- **Trash pattern**: entities use `trashed_at` (soft-delete); notes use `archived_at` (soft-delete); both have restore and delete-forever actions; `TrashView` in sidebar manages both; trashing from the list triggers a two-step confirmation flow when the item is linked/mentioned (entities: `entities:get-mention-count`; notes: `notes:get-link-count`); restore updates the module-level reactive status map (`entityTrashStatus` / `noteArchivedStatus`) so chips update without reloading notes; `closePanesForContent` is called on trash so open panes close immediately
- **Reactive mention chips**: `entityTrashStatus` (module-level `reactive(Map)`) drives chip appearance without re-loading notes — set on note load, on trash/restore anywhere in the app
- **Tab/pane system**: `tabStore` holds all content navigation state; `tabs` is a global (not per-view) array of `Tab` objects each with one or more `ContentPane`s; `Shift+click` adds a pane to the current tab (split view), `Cmd+click` opens a new tab; pane titles are updated on save via `updatePaneTitle`; trashing an entity closes all panes for it via `closePanesForContent`
- Context isolation + sandbox enabled; no Node integration in renderer
