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

- **better-sqlite3** with SQLite (WAL mode, FTS5, 64MB cache)
- Schema in `src/main/db/schema.ts` — 13 tables including `notes`, `note_chunks` (future embeddings), `entities`, `entity_mentions`, `note_relations`, `action_items`, `calendar_events`
- IPC handlers in `src/main/db/ipc.ts`:
  - Notes: `db:status`, `notes:create`, `notes:get`, `notes:update`, `notes:list`, `notes:delete`
  - Entity types: `entity-types:list`, `entity-types:create`, `entity-types:delete`
  - Entities: `entities:list`, `entities:create`, `entities:get`, `entities:update`, `entities:delete`
- `notes:delete` is a soft-delete (sets `archived_at`); `entities:delete` is a hard delete
- `notes:list` returns only non-archived notes sorted by `updated_at DESC`
- `entities:list` takes `{type_id}` and returns entities sorted by name
- `entity-types:delete` blocks deletion of built-in types (person, project, team, decision, okr)
- Dev DB: `wizz.dev.db`, Prod DB: `wizz.db` — both in Electron's `userData` directory

### Renderer / UI

- `App.vue` shell: sidebar with fixed nav items (Today, Notes) + **dynamic entity type list** (loaded from DB) + fixed items (Actions, Calendar, Search)
  - Entity type nav is populated from `entity-types:list` on mount; routes `activeView` to entity type IDs
  - "New entity type" button in sidebar opens `EntityTypeModal`
- `NoteList.vue` — note list pane (240px); exposes `refresh()` via `defineExpose`; emits `select` and `new-note`
- `NoteEditor.vue` uses **TipTap** (ProseMirror-based) for rich text editing with auto-save (500ms debounce); emits `saved` after each successful save
- `EntityList.vue` — generic entity list pane (mirrors NoteList); props: `typeId`, `typeName`, `activeEntityId`; emits `select`, `new-entity`; exposes `refresh()`
- `EntityDetail.vue` — dynamic entity form; renders fields from entity type schema JSON; explicit Save button; props: `entityId`; emits `saved`
- `EntityTypeModal.vue` — full entity type creation modal with field builder (name, icon, color swatches, dynamic field list with type/options/entity_ref picker)
- `ToolbarDropdown.vue` is a reusable dropdown used in the editor toolbar
- Path alias: `@` resolves to `src/renderer/`
- Icons: **lucide-vue-next** throughout

### Key Design Decisions

- **Local-first**: All data on-device in SQLite; no cloud backend currently
- **Chunked note storage**: `note_chunks` table is pre-built for a future 3-layer embedding hierarchy (raw → summary → cluster) for semantic search
- **FTS5** is already wired up on `notes` for full-text search
- Entity graph: `entities` + `entity_mentions` + `note_relations` form a knowledge graph linking notes to people/projects/teams/decisions/OKRs
- Context isolation + sandbox enabled; no Node integration in renderer
