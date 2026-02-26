# Computed Query Field — Design & Implementation Plan

## 1. Motivation

The entity system supports **entity_ref** and **entity_ref_list** for forward relationships.
But there is no way to express a **reverse relationship** without duplicating data.

**Example:**
- `Person` has field `team: entity_ref → Team`
- `Team` wants a field `members` that shows all Persons whose `team` is set to this Team

Today you'd have to maintain both sides manually. The `computed` field type solves this by
letting a field's value be **derived at display time** via a declarative query.

---

## 2. Query Language: WQL (Wizz Query Language)

A minimal SQL-inspired DSL designed to be easy to read, write, and parse. It intentionally
covers only the entity-graph use cases Wizz needs — it does not try to be full SQL.

### 2.1 Syntax

```
SELECT <alias>
FROM   <EntityType>
WHERE  <condition> [AND <condition>]*
[ORDER BY <alias>.<field> [ASC | DESC]]
[LIMIT <n>]
```

- **`<alias>`** — a short local variable name (`p`, `person`, anything)
- **`<EntityType>`** — name of an entity type (case-insensitive, e.g. `Person`)
- **`<condition>`** — `<alias>.<field> <op> <value>`
- **`<op>`** — `=`, `!=`, `<`, `>`, `<=`, `>=`, `CONTAINS`
- **`<value>`** — `{this}`, a quoted string `'text'`, a number, or an unquoted word
- **`{this}`** — special token: the ID of the entity currently being displayed

### 2.2 Examples

```sql
-- All Persons on this Team
SELECT p FROM Person WHERE p.team = {this}

-- All open Projects led by this Person
SELECT proj FROM Project WHERE proj.lead = {this} AND proj.status = 'active'

-- OKRs owned by this person, newest first
SELECT o FROM OKR WHERE o.owner = {this} ORDER BY o.name ASC

-- Top 10 decisions made by this person
SELECT d FROM Decision WHERE d.owner = {this} LIMIT 10
```

### 2.3 Design rationale vs alternatives

| Option | Pros | Cons |
|---|---|---|
| **WQL (chosen)** | Familiar, readable, easy to parse, easy to type-check | Custom parser to maintain |
| Raw SQL | Zero parsing needed | SQL injection risk, exposes DB internals, no `{this}` concept |
| JSONPath filter `Person[?team={this}]` | Compact | Unfamiliar, harder to read, limited expressiveness |
| GraphQL-style | Type-safe | Overkill, verbose, complex to learn |

WQL wins on readability and minimal implementation surface area.

### 2.4 Grammar (formal)

```ebnf
query       = "SELECT" alias "FROM" entity_type
              ["WHERE" condition ("AND" condition)*]
              ["ORDER" "BY" alias "." field ("ASC" | "DESC")]
              ["LIMIT" integer]

alias       = identifier
entity_type = identifier
condition   = alias "." field operator value
field       = identifier
operator    = "=" | "!=" | "<" | ">" | "<=" | ">=" | "CONTAINS"
value       = "{this}" | string_literal | number_literal | identifier
identifier  = /[a-zA-Z_][a-zA-Z0-9_]*/
string_lit  = "'" [^']* "'"
number      = /[0-9]+/
```

---

## 3. Data Model Changes

### 3.1 New field type

Add `computed` to the `FieldType` union in both `EntityTypeModal.vue` and `EntityDetail.vue`.

### 3.2 Updated `StoredFieldDef` shape

```typescript
type StoredFieldDef =
  | { name: string; type: 'text' | 'email' | 'date' | 'text_list' | 'note_ref' }
  | { name: string; type: 'select'; options: string[] }
  | { name: string; type: 'entity_ref' | 'entity_ref_list'; entity_type: string }
  | { name: string; type: 'computed'; query: string }   // ← NEW
```

The `query` string is the raw WQL source stored verbatim in the entity type schema JSON.

### 3.3 No changes to the `entities` table

`computed` fields are never written to `entities.fields`. They are derived at read time.

### 3.4 Schema example for Team with computed members

```json
{
  "fields": [
    { "name": "lead",    "type": "entity_ref", "entity_type": "person" },
    {
      "name": "members",
      "type": "computed",
      "query": "SELECT p FROM Person WHERE p.team = {this}"
    }
  ]
}
```

---

## 4. Query Execution (Main Process)

### 4.1 Architecture

Execution lives entirely in the main process, close to SQLite.

```
src/main/entity-query/
  types.ts       — AST type definitions
  parser.ts      — tokenizer + recursive-descent parser → QueryAST
  evaluator.ts   — QueryAST + thisId → SQL + execute → EntityRef[]
```

### 4.2 AST types (`types.ts`)

```typescript
export type Operator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'CONTAINS'

export interface Condition {
  alias: string
  field: string
  op: Operator
  value: string | number | '__this__'   // '__this__' = {this} placeholder
}

export interface QueryAST {
  alias: string
  entityTypeName: string              // raw name, resolved to ID at eval time
  conditions: Condition[]
  orderBy?: { field: string; dir: 'ASC' | 'DESC' }
  limit?: number
}
```

### 4.3 Parser (`parser.ts`)

Tokenizer converts the WQL string into a flat `Token[]` list.
A small recursive-descent parser consumes the token list and produces a `QueryAST`.

Key parsing steps:
1. `expect('SELECT')` → read `alias`
2. `expect('FROM')` → read `entityTypeName`
3. If next token is `WHERE` → parse conditions until `ORDER`/`LIMIT`/EOF
4. If next token is `ORDER` → expect `BY`, read `alias.field`, optional `ASC`/`DESC`
5. If next token is `LIMIT` → read integer

Error handling: `throw new QueryParseError(message)` with a human-readable message.
The error message is displayed inline in `EntityDetail` beneath the field label.

### 4.4 Evaluator (`evaluator.ts`)

```typescript
export function evalQuery(
  db: Database,
  ast: QueryAST,
  thisId: string
): { id: string; name: string; type_id: string }[]
```

Steps:
1. Resolve `entityTypeName` → `entity_type_id`:
   ```sql
   SELECT id FROM entity_types WHERE lower(name) = lower(?)
   ```
2. Build a parameterized SQLite query:
   ```sql
   SELECT e.id, e.name, e.type_id
   FROM   entities e
   WHERE  e.type_id = ?
     AND  e.trashed_at IS NULL
     AND  <condition_sql>
   [ORDER BY json_extract(e.fields, '$.<field>') ASC|DESC]
   [LIMIT ?]
   ```
3. For each condition:
   - If `value === '__this__'` → bind `thisId`
   - For `=` on an entity_ref field: `json_extract(e.fields, '$.field') = ?`
   - For `CONTAINS` on a text_list field: `json_extract(e.fields, '$.field') LIKE ?` with `%value%`
4. Execute with prepared statement (faster on repeated calls).
5. Return `{ id, name, type_id }[]` (max 200 rows, hard cap to prevent runaway queries).

### 4.5 Security

- WQL is user-authored content. The evaluator **never** interpolates values directly into SQL.
  All values go through SQLite prepared statement bindings.
- `thisId` is always the UUID of the currently-displayed entity (sourced from DB, not user input).
- Entity type resolution uses a parameterized query; the name is never concatenated into SQL.
- No raw SQL passthrough is possible through WQL.

---

## 5. IPC Handler

### 5.1 New handler: `entities:computed-query`

**Registered in:** `src/main/db/ipc.ts`

```typescript
ipcMain.handle(
  'entities:computed-query',
  (_event, { query, thisId }: { query: string; thisId: string }) => {
    try {
      const ast = parseQuery(query)
      const results = evalQuery(db, ast, thisId)
      return { ok: true, results }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }
)
```

Returns:
```typescript
| { ok: true;  results: { id: string; name: string; type_id: string }[] }
| { ok: false; error: string }
```

### 5.2 New handler: `entity-types:schema-for-autocomplete`

Used by the renderer to power WQL autocomplete.

```typescript
ipcMain.handle('entity-types:schema-for-autocomplete', () => {
  // Returns all entity type names + their field names
  return db.prepare(`SELECT id, name, schema FROM entity_types`).all()
    .map((row) => ({
      id: row.id,
      name: row.name,
      fields: (JSON.parse(row.schema as string)?.fields ?? []).map(
        (f: { name: string }) => f.name
      ),
    }))
})
```

---

## 6. Renderer: CodeMirror 6 Editor

### 6.1 New packages required

```
@codemirror/view
@codemirror/state
@codemirror/language
@codemirror/autocomplete
@codemirror/commands
```

All are lightweight, tree-shakeable, and have zero peer dependencies beyond each other.
No `@codemirror/lang-sql` — we define a custom stream language for WQL.

### 6.2 New file: `src/renderer/lib/wql-language.ts`

Defines a CodeMirror 6 `LanguageSupport` for WQL.

#### Token highlights

| WQL construct | CodeMirror token class | Color (dark theme) |
|---|---|---|
| `SELECT FROM WHERE AND OR ORDER BY ASC DESC LIMIT` | `keyword` | purple |
| `{this}` | `atom` | orange |
| `'string literal'` | `string` | green |
| Identifiers (alias, entity type, field name) | `variableName` | white/default |
| Operators `= != < > <= >= CONTAINS` | `operator` | cyan |
| Numbers | `number` | yellow |

#### Implementation sketch

```typescript
import { StreamLanguage, LanguageSupport } from '@codemirror/language'

const KEYWORDS = new Set([
  'SELECT','FROM','WHERE','AND','OR','ORDER','BY','ASC','DESC','LIMIT','CONTAINS'
])

const wqlStreamLang = StreamLanguage.define({
  token(stream) {
    if (stream.eatWhitespace()) return null
    if (stream.match('{this}')) return 'atom'
    if (stream.match(/<=|>=|!=|[<>=]/)) return 'operator'
    if (stream.match("'")) {
      while (!stream.eol() && stream.next() !== "'") {}
      return 'string'
    }
    if (stream.match(/[0-9]+/)) return 'number'
    if (stream.match(/[a-zA-Z_][a-zA-Z0-9_]*/)) {
      return KEYWORDS.has(stream.current().toUpperCase()) ? 'keyword' : 'variableName'
    }
    stream.next()
    return null
  },
  startState: () => ({}),
})

export function wqlLanguage(): LanguageSupport {
  return new LanguageSupport(wqlStreamLang)
}
```

### 6.3 Autocomplete source

Powered by `entity-types:schema-for-autocomplete` IPC, called once on editor mount and
cached in the component.

```typescript
async function getCompletions(context: CompletionContext): Promise<CompletionResult | null> {
  const { state, pos } = context
  const textBefore = state.doc.sliceString(0, pos)

  // After FROM keyword
  const fromMatch = /FROM\s+(\w*)$/i.exec(textBefore)
  if (fromMatch) {
    return {
      from: pos - fromMatch[1].length,
      options: entityTypes.map(t => ({ label: t.name, type: 'type' })),
    }
  }

  // After alias. (dot notation) → suggest field names
  // First find which alias maps to which entity type from the FROM clause
  const aliasMatch = /SELECT\s+(\w+)\s+FROM\s+(\w+)/i.exec(textBefore)
  const dotMatch = /(\w+)\.\s*(\w*)$/.exec(textBefore)
  if (dotMatch && aliasMatch && dotMatch[1] === aliasMatch[1]) {
    const typeName = aliasMatch[2].toLowerCase()
    const fields = entityTypes.find(t => t.name.toLowerCase() === typeName)?.fields ?? []
    return {
      from: pos - dotMatch[2].length,
      options: fields.map(f => ({ label: f, type: 'property' })),
    }
  }

  // After WHERE / AND / OR → suggest {this}
  if (/(?:WHERE|AND|OR)\s+\S+\s*[=!<>]+\s*$/i.test(textBefore)) {
    return {
      from: pos,
      options: [{ label: '{this}', type: 'keyword' }],
    }
  }

  return null
}
```

### 6.4 New component: `src/renderer/components/QueryFieldEditor.vue`

```
Props:
  modelValue: string      — raw WQL source
  readonly: boolean       — true when editing entity type, false not needed
  entityTypes: {...}[]    — for autocomplete

Emits:
  update:modelValue

Internals:
  - Creates EditorView on mount (basicSetup, wqlLanguage(), autocompletion({source}))
  - Updates view when modelValue changes externally (via EditorView.dispatch)
  - Destroys EditorView on unmount
  - Applies Wizz dark/light theme via a CodeMirror theme extension
  - Height: auto (min 2 lines, max 8 lines) via CSS
```

---

## 7. EntityTypeModal Changes

**File:** `src/renderer/components/EntityTypeModal.vue`

### 7.1 Add to FIELD_TYPES array

```typescript
{ value: 'computed', label: 'Computed query' }
```

### 7.2 Add `query` property to `FieldDef`

```typescript
type FieldDef = {
  name: string
  type: FieldType
  options: string
  entity_type: string
  query: string         // ← NEW — WQL source for 'computed' fields
}
```

### 7.3 Add editor in field row template

Below the `entity_type` picker, add a `v-else-if="field.type === 'computed'"` branch that
renders `<QueryFieldEditor v-model="field.query" />`.

### 7.4 `buildSchema()` update

```typescript
if (f.type === 'computed') {
  def.query = f.query.trim()
}
```

### 7.5 Load existing `computed` fields

When populating fields from existing schema (edit mode), set `field.query = stored.query ?? ''`.

---

## 8. EntityDetail Changes

**File:** `src/renderer/components/EntityDetail.vue`

### 8.1 Data structures

```typescript
// Computed field results (keyed by field name)
const computedResults = reactive<Record<string, { id: string; name: string; type_id: string }[]>>({})
const computedErrors = reactive<Record<string, string>>({})
const computedLoading = reactive<Record<string, boolean>>({})
```

### 8.2 Load computed fields

Called after `loadEntity()` (which already loads the entity and its type schema):

```typescript
async function loadComputedFields(): Promise<void> {
  if (!entity.value || !entityType.value) return
  const schema: EntitySchema = JSON.parse(entityType.value.schema)
  for (const field of schema.fields) {
    if (field.type !== 'computed') continue
    computedLoading[field.name] = true
    const res = await window.api.invoke('entities:computed-query', {
      query: field.query,
      thisId: entity.value.id,
    })
    computedLoading[field.name] = false
    if (res.ok) {
      computedResults[field.name] = res.results
    } else {
      computedErrors[field.name] = res.error
    }
  }
}
```

### 8.3 Template for computed field

Rendered **read-only** — no editing chips, no search input.

```vue
<template v-else-if="field.type === 'computed'">
  <div class="computed-field">
    <span v-if="computedLoading[field.name]" class="computed-loading">Loading…</span>
    <span v-else-if="computedErrors[field.name]" class="computed-error">
      {{ computedErrors[field.name] }}
    </span>
    <template v-else-if="computedResults[field.name]?.length">
      <div
        v-for="item in computedResults[field.name]"
        :key="item.id"
        class="ref-chip entity-chip computed-chip"
      >
        <button class="ref-chip-open" @click="openComputedEntity($event, item)">
          <ExternalLink :size="11" />
          {{ item.name }}
        </button>
      </div>
    </template>
    <span v-else class="computed-empty">—</span>
  </div>
</template>
```

### 8.4 Open handler (all 3 modes)

```typescript
function openComputedEntity(
  e: MouseEvent,
  item: { id: string; type_id: string; name: string }
): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-entity', { entityId: item.id, typeId: item.type_id, mode })
}
```

### 8.5 Refresh trigger

`loadComputedFields()` is called:
- After `loadEntity()` on mount and on `props.entityId` change
- When the entity is saved (after `entities:update`) — results may have changed if a
  field affecting the query was edited on a related entity

---

## 9. EntityMentionPopup Changes

**File:** `src/renderer/components/EntityMentionPopup.vue`

The popup shows a snapshot of entity fields. For `computed` fields:
1. Fetch results lazily via `entities:computed-query` (same as EntityDetail)
2. Display as a comma-separated list of entity name links (or "—" if empty)
3. No edit capability (popup is always read-only)

Add `computed` to the `isRef` check or add a separate `isComputed` branch in the
`fields` computed property.

---

## 10. File Map

```
New files:
  features/CUSTOM_QUERY.md                         ← this document
  src/main/entity-query/types.ts                   ← AST types
  src/main/entity-query/parser.ts                  ← WQL tokenizer + parser
  src/main/entity-query/evaluator.ts               ← AST → SQLite execution
  src/renderer/lib/wql-language.ts                 ← CodeMirror language + autocomplete
  src/renderer/components/QueryFieldEditor.vue     ← CodeMirror editor component

Modified files:
  src/main/db/ipc.ts                               ← add 2 new handlers
  src/renderer/components/EntityTypeModal.vue      ← add computed type + QueryFieldEditor
  src/renderer/components/EntityDetail.vue         ← render computed fields read-only
  src/renderer/components/EntityMentionPopup.vue   ← handle computed in popup
  package.json                                     ← add @codemirror/* deps
```

---

## 11. Implementation Checklist

### Phase 1 — Core (No UI niceties)

- [x] `src/main/entity-query/types.ts` — `QueryAST`, `Condition`, `Operator`
- [x] `src/main/entity-query/parser.ts` — tokenizer + parser → `QueryAST`
- [x] `src/main/entity-query/evaluator.ts` — `evalQuery(db, ast, thisId)`
- [x] `src/main/db/ipc.ts` — `entities:computed-query` handler
- [x] `EntityTypeModal.vue` — add `computed` field type with plain `<textarea>` for query
- [x] `EntityDetail.vue` — render computed fields as read-only chip list
- [x] Manually test: Team `members` = `SELECT p FROM Person WHERE p.team = {this}`

### Phase 2 — Syntax Highlighting

- [x] `npm install @codemirror/view @codemirror/state @codemirror/language @codemirror/autocomplete @codemirror/commands`
- [x] `src/renderer/lib/wql-language.ts` — `StreamLanguage` + `wqlLanguage()` export
- [x] `src/renderer/components/QueryFieldEditor.vue` — CodeMirror editor wrapper
- [x] `EntityTypeModal.vue` — swap `<textarea>` for `<QueryFieldEditor />`
- [x] Apply Wizz-consistent dark theme overrides via CodeMirror theme extension

### Phase 3 — Autocomplete (Stretch)

- [x] `src/main/db/ipc.ts` — `entity-types:schema-for-autocomplete` handler
- [x] `QueryFieldEditor.vue` — fetch schema on mount, build `getCompletions()` source
- [x] Autocomplete: entity type names after `FROM`
- [x] Autocomplete: field names after `alias.`
- [x] Autocomplete: `{this}` suggestion in value position

### Phase 4 — Polish

- [ ] `EntityMentionPopup.vue` — handle `computed` fields
- [ ] Error display in EntityDetail (parse/eval errors shown inline)
- [ ] Add `computed` field type to built-in `Team` schema (replace static `members` field)
- [ ] Update `CLAUDE.md` — document new field type, IPC handlers, and file structure

---

## 12. Testing Guide

1. **Create a "Person" type** with a field `team: entity_ref → Team`
2. **Create a "Team" type** with field `members: computed` and query:
   `SELECT p FROM Person WHERE p.team = {this}`
3. Create 3 Person entities, set each one's `team` to the same Team entity
4. Open the Team entity → `members` field should show the 3 Person chips
5. Create a 4th Person with a *different* team → should NOT appear in the first team's members
6. **Error handling**: enter an invalid query like `SELECT p FROM NonExistent WHERE p.x = {this}`
   → EntityDetail should show an inline error message, not crash
7. **Autocomplete** (Phase 3): in EntityTypeModal query editor, type `FROM ` and verify
   entity type names appear; type `p.` and verify field names appear
8. **Open modes**: Shift+click a member chip → opens in new pane; Cmd+click → new tab
