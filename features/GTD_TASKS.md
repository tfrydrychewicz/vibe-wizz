# GTD Tasks — Getting Things Done Methodology for Action Items

## Overview

Redesign the action items system to fully implement the **Getting Things Done (GTD)** methodology. The current kanban board is functional but surface-level: tasks have a title, status, assignee, and due date. GTD requires richer organisation — projects, contexts, waiting-for tracking, sub-tasks, and the ability to edit all task attributes directly from the note where the task was captured.

This feature also rethinks how task items in the note editor connect to the Actions dashboard: when a task is promoted (or auto-extracted), an AI pass derives structured attributes (project, assignee, due date, context) from the surrounding text, and those attributes become editable inline within the note view.

---

## GTD Concepts Mapped to Wizz

| GTD Concept | Wizz Implementation |
|-------------|-------------------|
| **Inbox** | Uncategorised tasks (no project, no context) — shown first in Next Actions view |
| **Next Actions** | Tasks with status `open` or `in_progress`, sorted by due date + context |
| **Projects** | Any entity of the user-configured "project" entity type; tasks link to one project |
| **Contexts** | Free-form tags on a task (e.g. `@computer`, `@phone`, `@office`) — stored as JSON array |
| **Waiting For** | `is_waiting_for: true` + optional `waiting_for_entity_id` — tasks blocked on someone |
| **Someday / Maybe** | `status: 'someday'` — not scheduled, not active |
| **Sub-tasks** | `parent_id` self-reference on `action_items`; shown inline under parent |
| **Weekly Review** | Dedicated review view surfacing stale/overdue/waiting items |
| **Capture** | Unchanged — `/action` slash command, AI extraction, manual creation |
| **Clarify** | AI derivation of attributes when promoting a task from a note |

---

## Data Model Changes

### New Columns on `action_items` (migration `0008`)

```sql
ALTER TABLE action_items ADD COLUMN parent_id TEXT REFERENCES action_items(id) ON DELETE SET NULL;
ALTER TABLE action_items ADD COLUMN project_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL;
ALTER TABLE action_items ADD COLUMN contexts TEXT DEFAULT '[]';  -- JSON string array e.g. '["@computer","@office"]'
ALTER TABLE action_items ADD COLUMN energy_level TEXT CHECK(energy_level IN ('low','medium','high') OR energy_level IS NULL);
ALTER TABLE action_items ADD COLUMN is_waiting_for INTEGER NOT NULL DEFAULT 0; -- BOOLEAN
ALTER TABLE action_items ADD COLUMN waiting_for_entity_id TEXT REFERENCES entities(id) ON DELETE SET NULL;
```

### Status Extension

Add `'someday'` and `'cancelled'` as visible first-class statuses (currently `cancelled` exists in schema but is invisible in the UI).

```
status: 'open' | 'in_progress' | 'done' | 'cancelled' | 'someday'
```

### New Indexes (migration `0008`)

```sql
CREATE INDEX IF NOT EXISTS idx_action_items_parent    ON action_items(parent_id);
CREATE INDEX IF NOT EXISTS idx_action_items_project   ON action_items(project_entity_id);
CREATE INDEX IF NOT EXISTS idx_action_items_waiting   ON action_items(is_waiting_for);
```

### New Settings Keys

| Key | Purpose | Default |
|-----|---------|---------|
| `gtd_project_entity_type_id` | Entity type used as "projects" in task organisation | `''` (disabled) |
| `gtd_default_context` | Pre-filled context string for new tasks | `''` |

### New IPC Channels

| Channel | Payload | Returns |
|---------|---------|---------|
| `action-items:list` | Extended: add `project_entity_id?`, `is_waiting_for?`, `parent_id?`, `context?`, `status_multi?: string[]` | `ActionItem[]` (with new fields + `project_name` JOIN) |
| `action-items:create` | Extended: add `parent_id?`, `project_entity_id?`, `contexts?`, `energy_level?`, `is_waiting_for?`, `waiting_for_entity_id?` | full row |
| `action-items:update` | Extended: same new fields | `{ ok }` |
| `action-items:derive-attributes` | `{ taskText: string, noteContext: string, noteId: string }` | `DerivedTaskAttributes` |
| `action-items:get` | `{ id: string }` | full `ActionItem` row with all joins |

### Extended `ActionItem` Type

```typescript
interface ActionItem {
  id: string
  title: string
  body: string | null
  source_note_id: string | null
  source_note_title: string | null
  assigned_entity_id: string | null
  assigned_entity_name: string | null
  project_entity_id: string | null
  project_name: string | null           // JOIN from entities.name
  parent_id: string | null
  due_date: string | null
  status: 'open' | 'in_progress' | 'done' | 'cancelled' | 'someday'
  extraction_type: 'manual' | 'ai_extracted'
  confidence: number
  contexts: string[]                    // parsed from JSON
  energy_level: 'low' | 'medium' | 'high' | null
  is_waiting_for: boolean
  waiting_for_entity_id: string | null
  waiting_for_entity_name: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  subtask_count: number                 // COUNT of children
  open_subtask_count: number
}
```

### `DerivedTaskAttributes` Type

```typescript
interface DerivedTaskAttributes {
  project_entity_id: string | null      // matched from known projects
  project_name: string | null
  assigned_entity_id: string | null     // matched from known entities
  assigned_entity_name: string | null
  due_date: string | null               // ISO 8601 date
  contexts: string[]                    // e.g. ['@computer']
  energy_level: 'low' | 'medium' | 'high' | null
  is_waiting_for: boolean
  waiting_for_entity_id: string | null
  waiting_for_entity_name: string | null
  confidence: number                    // 0.0–1.0
}
```

---

## AI: Attribute Derivation (`action-items:derive-attributes`)

When a task is promoted from a note (or newly auto-extracted), Wizz calls a single Claude Haiku pass that reads the task text + surrounding note context and returns structured attributes. This runs as a fire-and-forget with the result pre-filling the task detail panel.

**Inputs injected into prompt:**
- Task text (verbatim)
- Note body_plain (truncated to 1500 chars, centred around task position)
- List of known project entities (name + id, from the configured GTD project entity type)
- List of known Person entities (name + id) from entity index
- Today's date

**Output (JSON):**
```json
{
  "project_entity_id": "<id or null>",
  "assigned_entity_id": "<id or null>",
  "due_date": "<YYYY-MM-DD or null>",
  "contexts": ["@computer"],
  "energy_level": "medium",
  "is_waiting_for": false,
  "waiting_for_entity_id": null,
  "confidence": 0.85
}
```

Uses slot `task_clarify` (new feature slot added to `featureSlots.ts`, default chain: Claude Haiku).

---

## UI Components

### New / Redesigned Components

#### `ActionsView.vue` — Redesigned

Replace the single kanban board with a **tabbed GTD dashboard**:

```
┌─────────────────────────────────────────────────────────────┐
│  ✅ Actions                                     [+ New Task] │
│  ─────────────────────────────────────────────────────────  │
│  [Next Actions] [Projects] [Waiting For] [Someday] [Review] │
│  ─────────────────────────────────────────────────────────  │
│                                                              │
│  Next Actions tab:                                           │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 📥 Inbox (no project)                     3 tasks  ▼  │ │
│  │   ☐ Review Sasha's design doc    @computer  Due Wed    │ │
│  │   ☐ Send headcount request                 Due Fri     │ │
│  │   ☐ Follow up with @John                              │ │
│  ├────────────────────────────────────────────────────────┤ │
│  │ 📁 Project Bifrost                        5 tasks  ▼  │ │
│  │   ☐ Write migration plan         @computer  ⚡ High    │ │
│  │     ☐ Draft schema changes                  (sub-task) │ │
│  │     ☐ Review with @Sarah                    (sub-task) │ │
│  │   ☐ Update runbook                                    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**Tabs:**
- **Next Actions** — grouped by project (Inbox first); shows open + in_progress; sub-tasks nested inline; filter bar for context / assignee / energy
- **Projects** — one row per project entity; shows open task count + next action; click to filter Next Actions to that project
- **Waiting For** — all tasks with `is_waiting_for: true`; grouped by waiting_for entity
- **Someday** — tasks with `status: 'someday'`; minimal, reviewable
- **Weekly Review** — read-only summary: overdue, stale (no update in 7d), waiting items older than 7d; "Reviewed" button

**Filter bar** (Next Actions tab):
- Context chips (all contexts from visible tasks, multi-select)
- Energy level filter (low / medium / high)
- Assignee filter (entity picker)
- Due date range (Today / This week / All)

#### `TaskCard.vue` — New Reusable Component

Replaces inline card markup in ActionsView. Used anywhere a task appears (actions view, daily brief, note-linked task list).

Props:
```typescript
{
  task: ActionItem
  depth?: number        // 0 = top-level, 1 = sub-task (indent + smaller text)
  showProject?: boolean
  showSourceNote?: boolean
}
```

Features:
- Checkbox (toggles open ↔ done, updates via IPC)
- Title (click → opens `TaskDetailPanel`)
- Project chip (if `showProject` and project set)
- Due date badge (red if overdue)
- Context chips
- Energy dot (●)
- Assignee avatar (initials)
- Waiting-for indicator (⏳ icon)
- Source note chip (if `showSourceNote`)
- Hover: sub-task count badge, "Add sub-task" button

Emits: `open-detail`, `status-changed`, `add-subtask`

#### `TaskDetailPanel.vue` — New Full Task View

A **right-side panel** (380px, same pattern as `ChatSidebar`) that opens when clicking a task card. Shows all task attributes in an editable form, plus its sub-tasks.

```
┌────────────────────────────────────────────┐
│  ← Back           ☐ Review Sasha's PR  ✕  │
│  ────────────────────────────────────────  │
│  Status:   [○ Open ▼]                      │
│  Project:  [📁 Bifrost ×]   [+ Set project]│
│  Assignee: [@Sarah ×]       [+ Assign]     │
│  Due date: [2026-03-10]     [× Clear]      │
│  Contexts: [@computer ×] [+ Add]           │
│  Energy:   [● Low] [● Med] [●● High]       │
│                                            │
│  Waiting for: ○ No  ● Yes → [@Sarah]       │
│                                            │
│  Notes:                                    │
│  ┌──────────────────────────────────────┐  │
│  │ (plain text, auto-saves)            │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  Sub-tasks                      [+ Add]    │
│  ☐ Draft schema changes                    │
│  ☐ Review with @Sarah                      │
│                                            │
│  Source: [📝 Feb 25 - Platform Standup →]  │
│  Created: Feb 25 · Updated: 1h ago         │
└────────────────────────────────────────────┘
```

All fields save instantly on change (no Save button) via `action-items:update`. Sub-tasks rendered as `TaskCard` at depth=1. "Add sub-task" opens an inline input.

#### `TaskInlineDetail.vue` — New Note-Embedded Task View

When a task item in the note editor is linked (has `actionId`), clicking the link badge opens a **compact popover** anchored to the task line (same pattern as `EntityMentionPopup`). Shows and edits the same attributes as `TaskDetailPanel` in a condensed layout.

```
┌──────────────────────────────────────────────┐
│ ☐ Review Sasha's PR             Open in Actions → │
│ ────────────────────────────────────────────  │
│ Project: 📁 Bifrost          Due: Mar 10      │
│ Assignee: @Sarah             Energy: ● Med    │
│ Contexts: @computer                           │
│ Waiting for: —                                │
│                                               │
│ [✕ Unlink from note]                          │
└──────────────────────────────────────────────┘
```

All fields editable inline. Changes call `action-items:update` immediately.

#### `TaskAttributeChip.vue` — New Reusable Chip

Reusable chip for displaying a single task attribute (project, context, energy, waiting-for). Used in `TaskCard`, `TaskInlineDetail`, and `TaskDetailPanel`.

Props: `type: 'project' | 'context' | 'energy' | 'waiting'`, `label: string`, `color?: string`, `removable?: boolean`

#### `SubTaskInput.vue` — New Inline Sub-task Creator

Used inside `TaskDetailPanel` and `TaskCard` (on hover). Minimal single-line text input + Enter to create sub-task (calls `action-items:create` with `parent_id`).

#### `GTDWeeklyReview.vue` — New Review Component

Rendered inside the **Weekly Review** tab. Read-only digest:
- **Overdue** — tasks past due date, grouped by project
- **Stale** — open tasks not updated in N days (uses `followup_staleness_days` setting)
- **Waiting** — `is_waiting_for` items grouped by who you're waiting on, sorted by age
- **Someday** — quick list; "Activate" button moves to open; "Delete" removes
- "Mark week reviewed" button (records `last_review_at` in settings)

---

## Settings Changes (`SettingsModal.vue` — Actions tab)

Add a new **Actions** section (or sub-tab within AI) in Settings:

```
Actions & GTD
─────────────────────────────────────────────
Project entity type:   [Project ▼]
  Entity type whose instances are treated as GTD projects.
  Tasks can be linked to any entity of this type.

Default context:       [@computer          ]
  Pre-filled context tag for new tasks.

Follow-up staleness:   [7] days
  Tasks assigned to others flagged in Weekly Review after this many days.
```

Saves to: `gtd_project_entity_type_id`, `gtd_default_context`, `followup_staleness_days` (already exists, moved here from AI section).

---

## Note Editor Integration Enhancements

### Task Promotion Flow (enhanced)

Current flow: promote button → `action-items:create` → linked badge.

New flow:
1. User clicks promote button on a task item
2. Task is created immediately (optimistic) — badge changes to linked
3. `action-items:derive-attributes` fires **in the background** with task text + note context
4. When derivation completes, `TaskInlineDetail` popover auto-opens (if note still focused) with derived attributes pre-filled — user reviews, tweaks, closes
5. If popover is not opened (user navigated away), attributes are saved silently

### Linked Task Badge (enhanced)

The existing link badge (Link2 icon) is replaced with a richer inline chip:

```
[✓ Review Sasha's PR   📁 Bifrost  Mar 10  →]
```

- Shows task title (truncated), project chip, due date if set
- Click → opens `TaskInlineDetail` popover
- Status colour: green = done, amber = in_progress, grey = open, red = overdue
- Consistent with `MentionChip` / `NoteLinkChip` visual language

### `/task` Slash Command (new, replaces `/action`)

Keep `/action` as alias. New primary name is `/task` for consistency with GTD vocabulary.

The command now shows a two-option dropdown:
- **Extract tasks** (AI) — existing `/action` behaviour
- **Insert task** (manual) — inserts a single blank `taskItem` node ready to type into

### Store: `taskActionStore.ts` (extended)

Add `openTaskDetail(actionId: string)` — triggers `TaskDetailPanel` or `TaskInlineDetail` depending on context (note editor vs. actions view).

---

## AI Feature Slot

Add to `featureSlots.ts`:

```typescript
{ id: 'task_clarify', label: 'Task attribute derivation', capability: 'chat', description: 'Derives project, assignee, due date, context from task text and surrounding note context' }
```

Default chain: Claude Haiku. Visible in Settings → AI Features.

---

## Implementation Checklist

### Phase A — Data Layer

- [x] **Migration `0008`**: add `parent_id`, `project_entity_id`, `contexts`, `energy_level`, `is_waiting_for`, `waiting_for_entity_id` columns to `action_items`; add indexes; register in `ALL_MIGRATIONS`
- [x] **`action-items:list` IPC**: extend to return new fields; add `project_name` via LEFT JOIN on entities; add filter params (`project_entity_id`, `is_waiting_for`, `parent_id`, `status_multi`); emit subtask counts via subquery
- [x] **`action-items:create` IPC**: accept and persist new fields
- [x] **`action-items:update` IPC**: accept and persist new fields; update `updated_at`; fires `action:updated` + `action:status-changed`
- [x] **`action-items:get` IPC**: single item fetch with all joins (including waiting_for entity name)
- [x] **`action-items:derive-attributes` IPC**: call `deriveTaskAttributes()` from `src/main/embedding/taskClarifier.ts`; inject known projects + persons; return `DerivedTaskAttributes`
- [x] **`taskClarifier.ts`**: new file in `src/main/embedding/`; uses `callWithFallback('task_clarify', ...)` slot; prompt loads project + person entities from DB; validates IDs against injected lists; graceful fallback (`confidence: 0`)
- [x] **`featureSlots.ts`**: add `task_clarify` slot (Chat capability, default Haiku)
- [x] **Settings keys**: `gtd_project_entity_type_id`, `gtd_default_context` — no migration needed (settings table is key-value)
- [x] **Extended `ActionItem` TypeScript type**: inline in `ACTION_SELECT` constant in `ipc.ts`; all new fields returned from every action-items query
- [x] **`DerivedTaskAttributes` type**: exported from `taskClarifier.ts`; preload bridge is generic (`window.api.invoke`) so no bridge changes needed
- [x] **`schema.ts` updated**: `action_items` table definition updated for fresh installs (new columns + `someday` in status CHECK + new indexes)

### Phase B — Reusable Components

- [x] **`TaskAttributeChip.vue`**: reusable chip for project / context / energy / waiting-for; props: `type`, `label`, `color`, `removable`; emits `remove`
- [x] **`SubTaskInput.vue`**: single-line input to create sub-task; props: `parentId`, `sourceNoteId`; calls `action-items:create` with `parent_id`; emits `created`
- [x] **`TaskCard.vue`**: replaces inline card markup; props: `task`, `depth`, `showProject`, `showSourceNote`; checkbox toggles status; click title → emit `open-detail`; hover shows sub-task count + add button; uses `TaskAttributeChip` for project / contexts / energy

### Phase C — Task Detail Panel

- [x] **`TaskDetailPanel.vue`**: right-side slide-in panel (380px); shows all task fields as instant-save editable controls; sub-tasks list using `TaskCard` at depth=1 + `SubTaskInput`; source note chip (all 3 open modes); "Open in Actions" button; `Cmd+W` closes; accessible as `showTaskDetail` ref in `App.vue`
- [x] **`App.vue`**: wire `TaskDetailPanel` (same pattern as `ChatSidebar`); `openTaskDetail(id)` helper calls `action-items:get` and sets active task; `taskStore` (module-level) exposes `openTaskDetail` so child components can trigger it without prop-drilling
- [x] **`taskDetailStore.ts`**: module-level store; `activeTaskId`, `registerOpenHandler`, `fireOpenDetail`; same pattern as `taskActionStore.ts`

### Phase D — Redesigned ActionsView

- [x] **`ActionsView.vue`**: replace single kanban with tabbed GTD dashboard:
  - Tab bar: Next Actions / Projects / Waiting For / Someday / Weekly Review
  - Persist active tab to `localStorage`
  - "New Task" button always visible in header
- [x] **Next Actions tab**: grouped by project (Inbox first); each group collapsible (persist collapse state); `TaskCard` for each task; sub-tasks nested inline; filter bar (context chips, energy, assignee, due date)
- [x] **Projects tab**: one row per project entity (loaded from entities by `gtd_project_entity_type_id`); shows open task count + next due; click row → filter Next Actions to that project; "No project" entity type configured → friendly empty state with link to Settings
- [x] **Waiting For tab**: `action-items:list` with `is_waiting_for: true`; grouped by `waiting_for_entity_name`; age badge (days since `updated_at`)
- [x] **Someday tab**: `action-items:list` with `status: 'someday'`; minimal list; per-item "Activate" (→ open) and "Delete" actions
- [x] **Weekly Review tab**: `GTDWeeklyReview.vue` component; loads overdue / stale / waiting items; "Mark reviewed" writes `gtd_last_review_at` setting

### Phase E — Note Editor Task Detail

- [x] **`TaskInlineDetail.vue`**: floating popover anchored to task line; shows + edits all task attributes (same fields as `TaskDetailPanel`, condensed); uses `TaskAttributeChip`; "Open in Actions →" link; "Unlink" button clears `actionId` on the TipTap node; closes on click-outside / Escape
- [x] **`ActionTaskItem.vue`**: upgrade linked badge to rich chip showing status dot + project + due date; badge colour reflects status (grey/amber/green/red/purple); click → `fireShowInlineDetail(actionId, rect)` via `taskInlineDetailStore`; reads from `taskDataCache`
- [x] **`NoteEditor.vue`**: registers show/unlink handlers; `syncTaskItemsWithDB` populates `taskDataCache`; `action:status-changed` updates cache; `TaskInlineDetail` in template; unlink handler clears `actionId` from TipTap node

### Phase F — Promotion Flow + AI Derivation

- [x] **`ActionTaskItem.vue` promote flow**: after `action-items:create`, immediately calls `action-items:derive-attributes`; loading spinner on badge during derivation; on result calls `action-items:update` with derived attributes AND opens `TaskInlineDetail` popover; confidence < 0.5 → popover still opens (empty state, user fills manually)
- [x] **`NoteEditor.vue` `/task` slash command**: `/task` is primary command with two-option sub-menu ("Extract tasks (AI)" → `task:extract`, "Insert blank task" → `task:blank`); `/action` kept as alias for AI extract
- [x] **`SlashCommandList.vue`**: supports sub-commands (second-level list); parent items show `▸` chevron; ArrowRight/Enter enters sub-menu; Escape/ArrowLeft exits; sub-item selected → calls `command(subItem)`

### Phase G — Settings UI

- [x] **`SettingsModal.vue`**: added **Actions** tab (between AI and Calendar); renders `GTDSettingsPanel.vue`; removed staleness days from AI → Follow-up tab (moved to Actions)
- [x] **`GTDSettingsPanel.vue`**: project entity type picker (`entity-types:list`, shows icon + name preview); default context tag input (`gtd_default_context`); Follow-up Intelligence section with staleness days (`followup_staleness_days`); Weekly Review section with last review date + "Mark reviewed now" button; explicit Save button

### Phase H — Daily Brief + AI Chat Integration

- [x] **`dailyBrief.ts`**: extend prompt to include project names on stale / overdue tasks; replace "stale follow-up" section with richer GTD-aware section
- [x] **`chat.ts` WIZZ_TOOLS**: extend `create_action_item` and `update_action_item` tools with new fields (`project_entity_id`, `contexts`, `energy_level`, `is_waiting_for`, `parent_id`); Claude can now set GTD attributes when creating tasks from chat
- [x] **`actionExtractor.ts`**: when extracting actions from a note, also run `deriveTaskAttributes` for each extracted item (batch call); persist derived attributes on creation

### Phase I — Push Events and Live Sync

- [x] **Push events**: add `action:updated` push (same pattern as `action:created`, `action:status-changed`); `ActionsView` and open `TaskDetailPanel` both listen and update in place
- [x] **`action-items:update` IPC**: fire `action:updated` after any change (currently only fires `action:status-changed` on status change); carry changed fields in payload so listeners can do minimal DOM updates

### Phase J — Polish

- [x] Keyboard shortcut `Cmd+Shift+A` → jump to Actions view
- [ ] `TaskCard` drag-and-drop reordering within a project group (persist via `position` field — future, mark as stretch goal)
- [x] Empty states: "Inbox is empty", "No projects configured", "Nothing waiting" — all have helpful instructions
- [x] Accessibility: all interactive task fields have ARIA labels; `TaskDetailPanel` has `role="complementary"` and `aria-pressed` on toggle buttons
- [x] Update `DESIGN.md` phase checklist and IPC reference to reflect all changes
- [x] Update `CLAUDE.md` with new IPC channels, components, and settings keys

---

## Consistency & Reuse Notes

- `TaskAttributeChip` must visually match `MentionChip` and `NoteLinkChip` — same border radius, same padding, same hover/remove button style
- `TaskDetailPanel` must use the same slide-in animation and width as `ChatSidebar`
- `TaskInlineDetail` popover must use the same positioning + click-outside pattern as `EntityMentionPopup` and `NoteLinkPopup`
- `SubTaskInput` uses the same debounce-on-Enter + optimistic-update pattern as the inline new-item form in the current `ActionsView`
- All new content-opening buttons (task title, source note chip) must support all 3 open modes (plain / Shift / Cmd+click)
- Project entity picker in `TaskDetailPanel` and `TaskInlineDetail` must reuse `entities:search` IPC — same pattern as the attendee entity search in `MeetingModal`
- Context chips use the existing chip/tag visual system; context input is a simple free-text add (type + Enter), no autocomplete needed in v1
- Status `'someday'` renders with a moon icon (🌙), distinct from the grey/amber/green/red status dots

---

## File Map

| New/changed file | Purpose |
|-----------------|---------|
| `src/main/db/migrations/0008_gtd_task_fields.ts` | Migration: new columns |
| `src/main/embedding/taskClarifier.ts` | AI derivation of task attributes |
| `src/main/ai/featureSlots.ts` | Add `task_clarify` slot |
| `src/main/db/ipc.ts` | Extend action-items IPC handlers |
| `src/renderer/components/ActionsView.vue` | Redesigned GTD dashboard |
| `src/renderer/components/TaskCard.vue` | Reusable task card |
| `src/renderer/components/TaskDetailPanel.vue` | Full task detail panel |
| `src/renderer/components/TaskInlineDetail.vue` | Popover for note-linked tasks |
| `src/renderer/components/TaskAttributeChip.vue` | Reusable attribute chip |
| `src/renderer/components/SubTaskInput.vue` | Inline sub-task creator |
| `src/renderer/components/GTDWeeklyReview.vue` | Weekly review component |
| `src/renderer/components/GTDSettingsPanel.vue` | Settings panel for Actions tab |
| `src/renderer/components/ActionTaskItem.vue` | Enhanced TipTap node view |
| `src/renderer/stores/taskDetailStore.ts` | Module-level open-detail store |
| `src/renderer/App.vue` | Wire TaskDetailPanel, taskDetailStore |
| `src/renderer/components/NoteEditor.vue` | Promote flow, `/task` command |
| `src/renderer/components/SlashCommandList.vue` | Sub-command support |
| `src/renderer/components/SettingsModal.vue` | Add Actions tab |
| `src/main/embedding/chat.ts` | Extend WIZZ_TOOLS with GTD fields |
| `src/main/embedding/actionExtractor.ts` | Batch derive attributes on extraction |
| `src/main/embedding/dailyBrief.ts` | GTD-aware brief sections |
