# Entity List Grouping & Sorting

## Overview

Entity lists currently show items sorted alphabetically by name with no grouping. This feature lets users sort and group entities by any of their fields — including the universal fields (name, date created, date updated) and any custom schema fields — with preferences persisted per entity type across sessions.

## Problem

An engineering manager with 20 direct reports wants to view them grouped by team, or sorted by role. A project list sorted by status would be far more actionable than an alphabetical dump. Currently there is no way to change the order or organise entities visually beyond what the schema dictates.

## Solution

Add a **sort / group toolbar** to `EntityList.vue`. Users can:

- **Sort** by name, date created, date updated, or any scalar custom field — in ascending or descending order
- **Group** by any `select` field or by name initial — items visually separated into labelled sections

Preferences are stored per entity type in a single settings key (`entity_list_prefs`), so they survive app restarts and are independent per type (Person list grouped by team, Project list grouped by status).

---

## User Experience

### Sort toolbar

A compact toolbar row sits between the "New …" button and the list scroll area:

```
┌─────────────────────────────┐
│  + New Person               │
├─────────────────────────────┤
│  Name ↑  |  Group: Team     │  ← sort/group bar
├─────────────────────────────┤
│  ▸ Backend                  │  ← group header
│    Alice                    │
│    Bob                      │
│  ▸ Frontend                 │
│    Carol                    │
└─────────────────────────────┘
```

- **Sort button** — shows current sort field + direction arrow (↑ / ↓); clicking opens a small dropdown:
  - Name
  - Date created
  - Date updated
  - — (divider) —
  - *[custom sortable fields from schema, e.g. Role, Team, Status…]*
  - Clicking the already-selected field toggles direction (↑ ↔ ↓)
- **Group button** — shows current group field or "No grouping"; clicking opens a dropdown:
  - No grouping
  - Name (A–Z sections)
  - — (divider) —
  - *[`select` type fields only, e.g. Status, Priority…]*

Both buttons are subtle icon-label combos that do not take up much vertical space (28px row).

### Grouped list

When a group field is active:
- Entities are sorted first by group value (alphabetically), then by the chosen sort field within each group
- Each group gets a sticky section header: `Team: Backend (3)` — bold label + count
- A `None` group (entities where the field is empty) is listed last, labelled `— No [FieldLabel] —`
- Collapse/expand per group is **not** in scope for the initial version (keeps the implementation simple)

### Sort-only (no group)

When grouping is off, items render in a flat list sorted by the chosen field, identical to today's layout except for order.

---

## Architecture

### Sortable field types

| Field type | Sortable | Groupable | Notes |
|-----------|----------|-----------|-------|
| `name` (built-in) | ✅ | ✅ (initial) | Always available |
| `created_at` (built-in) | ✅ | — | Chrono sort |
| `updated_at` (built-in) | ✅ | — | Chrono sort |
| `text` | ✅ | — | String compare |
| `email` | ✅ | — | String compare |
| `date` | ✅ | — | ISO date string, sortable |
| `select` | ✅ | ✅ | Finite options → natural groups |
| `text_list` | — | — | Not meaningful |
| `entity_ref` | — | — | Not meaningful |
| `entity_ref_list` | — | — | Not meaningful |
| `note_ref` | — | — | Not meaningful |
| `computed` | — | — | Not meaningful |

### Settings persistence

A single settings key `entity_list_prefs` stores a JSON object keyed by `typeId`:

```typescript
type EntityListPrefs = {
  sortField: string        // 'name' | 'created_at' | 'updated_at' | custom field name
  sortDir: 'asc' | 'desc'
  groupField: string | null  // null = no grouping; 'name' = initial; custom field name
}

type AllEntityListPrefs = Record<string, EntityListPrefs>
// e.g. { "person-type-id": { sortField: 'name', sortDir: 'asc', groupField: 'team' } }
```

Load on `EntityList` mount → `settings:get({ key: 'entity_list_prefs' })` → parse JSON → look up by `typeId`.
Save on any change → merge into the parsed object → `settings:set({ key: 'entity_list_prefs', value: JSON.stringify(updated) })`.

### IPC changes — `entities:list`

Extend the handler to accept sort parameters. Sorting is pushed to SQLite for correctness and performance.

**New payload:** `{ type_id, sortField?, sortDir?, includeFields? }`

- `sortField` defaults to `'name'`
- `sortDir` defaults to `'asc'`
- `includeFields: true` causes `fields` to be included in the response (needed so the renderer can extract the group field value without a second round-trip)

SQL construction:

```typescript
// Built-in columns
const BUILTIN_SORT_COLS = {
  name: 'name COLLATE NOCASE',
  created_at: 'created_at',
  updated_at: 'updated_at',
}

const orderExpr = BUILTIN_SORT_COLS[sortField]
  ?? `JSON_EXTRACT(fields, '$.${sanitizeFieldName(sortField)}') COLLATE NOCASE`

const sql = `
  SELECT id, name, type_id, updated_at, created_at${includeFields ? ', fields' : ''}
  FROM entities
  WHERE type_id = ? AND trashed_at IS NULL
  ORDER BY ${orderExpr} ${sortDir === 'desc' ? 'DESC' : 'ASC'}
`
```

`sanitizeFieldName` must whitelist characters to `[a-zA-Z0-9_]` to prevent SQL injection through field names.

### Renderer-side grouping

Grouping is applied in the renderer after receiving the sorted list:

```typescript
// computed in EntityList.vue
const groupedEntities = computed(() => {
  if (!prefs.value.groupField) return [{ label: null, items: entities.value }]

  const groups = new Map<string, EntityListItem[]>()
  for (const e of entities.value) {
    const key = getGroupKey(e, prefs.value.groupField) // '' for missing values
    const existing = groups.get(key) ?? []
    existing.push(e)
    groups.set(key, existing)
  }

  // Sort group keys alphabetically; empty key (no value) goes last
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b)
  })

  return sorted.map(([key, items]) => ({
    label: key || null,  // null → render as "— No [Field] —"
    items,
  }))
})
```

`getGroupKey` extracts the field value:
- `'name'` → first letter of `entity.name`, uppercased
- custom field → `JSON.parse(entity.fields)[fieldName] ?? ''`

### New component — `EntityListSortBar.vue`

A focused, reusable component for the sort/group toolbar. Keeps `EntityList.vue` clean.

```
props:
  sortField: string
  sortDir: 'asc' | 'desc'
  groupField: string | null
  sortableFields: { name: string; label: string }[]   // computed from schema
  groupableFields: { name: string; label: string }[]  // select fields only

emits:
  update:sortField
  update:sortDir
  update:groupField
```

Uses a small inline dropdown (`ToolbarDropdown.vue` — already exists) for the sort and group pickers. Reuses the same visual language as the rest of the app toolbar.

---

## Files Changed

| File | Change |
|------|--------|
| `src/main/db/ipc.ts` | Extend `entities:list` handler: accept `sortField`, `sortDir`, `includeFields`; build safe ORDER BY clause |
| `src/renderer/components/EntityList.vue` | Load/save prefs; pass sort params to IPC; compute groupings; render group headers |
| `src/renderer/components/EntityListSortBar.vue` | New component — sort field dropdown, direction toggle, group field dropdown |
| `src/main/db/schema.ts` | No change (prefs stored in existing `settings` table via key `entity_list_prefs`) |

No migration needed — uses the existing `settings` key-value table.

---

## Implementation Checklist

- [x] **IPC — `entities:list` extended**
  - [x] Accept `sortField?: string`, `sortDir?: 'asc' | 'desc'`, `includeFields?: boolean` in payload
  - [x] Whitelist built-in sort columns (`name`, `created_at`, `updated_at`)
  - [x] For custom fields: build `JSON_EXTRACT(fields, '$.{field}')` ORDER BY; sanitize field name to `[a-zA-Z0-9_]` only to prevent injection
  - [x] Return `fields` column when `includeFields` is true
  - [x] Default to `ORDER BY name COLLATE NOCASE ASC` when params are absent (backward compatible)
  - [x] Update TypeScript payload type

- [x] **`EntityListSortBar.vue` — new component**
  - [x] Props: `sortField`, `sortDir`, `groupField`, `sortableFields[]`, `groupableFields[]`
  - [x] Sort button: shows current field label + ↑/↓ arrow; clicking opens dropdown (reuse `ToolbarDropdown.vue`)
  - [x] Sort dropdown: built-in fields (Name, Date created, Date updated) + divider + custom sortable fields
  - [x] Clicking the already-active field in the dropdown toggles direction
  - [x] Group button: shows "Group: [label]" or "No grouping"; clicking opens dropdown
  - [x] Group dropdown: "No grouping" + divider + "Name (A–Z)" + select-type custom fields
  - [x] Emit `update:sortField`, `update:sortDir`, `update:groupField` on change

- [x] **`EntityList.vue` — sort/group wiring**
  - [x] On mount: load `entity_list_prefs` from settings → parse JSON → read prefs for `typeId`; fall back to `{ sortField: 'name', sortDir: 'asc', groupField: null }`
  - [x] On mount: also load entity type schema (via `entity-types:list`) to derive `sortableFields` and `groupableFields` arrays
  - [x] Pass sort params to `entities:list` IPC call; pass `includeFields: true` when a group field is active
  - [x] Compute `groupedEntities` from the flat entity list using the group field
  - [x] Render `EntityListSortBar` in the header between the "New" button and the scroll area
  - [x] Render grouped list: section header per group, then items; "— No [Field] —" for empty-value group
  - [x] On any pref change: save to settings; re-fetch list
  - [x] Watch `typeId` prop change → reload prefs for the new type (existing watch already triggers `refresh()`)

- [x] **Settings persistence**
  - [x] Load: `settings:get({ key: 'entity_list_prefs' })` → `JSON.parse` → pick `prefs[typeId] ?? defaults`
  - [x] Save: merge updated prefs into the full object → `settings:set({ key: 'entity_list_prefs', value: JSON.stringify(all) })`
  - [x] Handle missing / corrupt JSON gracefully (fall back to defaults, don't crash)

- [x] **Derived field lists from schema**
  - [x] `sortableFields` = fields where `type` is one of `text`, `email`, `date`, `select`
  - [x] `groupableFields` = fields where `type === 'select'` or `type === 'entity_ref'` (plus a synthetic `'name'` → "Name (A–Z)" entry); entity_ref values resolved to referenced entity names asynchronously
  - [x] If `typeId` changes and the stored `sortField` no longer exists in the new schema, reset to `'name'`

- [x] **Validation / edge cases**
  - [x] Entity type with no custom fields: toolbar only shows built-in sort options; group button shows only "Name (A–Z)"
  - [x] Group field value is an array (should never happen for `select`, but guard with `String()` coercion)
  - [x] Empty list: existing "No [type]s yet" empty state still shown correctly inside groups
  - [x] `typeId` change while a popover is open: close the popover

- [x] **Visual polish**
  - [x] Sort bar is visually subtle (muted text, 28px height) — doesn't compete with entity names
  - [x] Active sort field and direction clearly indicated in the button label
  - [x] Active group field indicated in the group button label
  - [x] Group section headers styled consistently with app (small caps or muted label, count badge)
