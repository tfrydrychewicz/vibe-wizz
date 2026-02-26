# Chat Rich Context — Design & Implementation Plan

## 1. Overview

Two related enhancements to the AI chat sidebar that make Claude aware of more of the user's
knowledge graph when composing a response:

1. **`[[note]]` mention in chat** — type `[[` to search and pin a note into the conversation
   context, similar to how `@entity` mentions already work.

2. **Deep entity context** — when an entity is `@mention`ed in chat, inject not just its name
   and type but also its **field values**, resolving `entity_ref` / `entity_ref_list` references
   one level deep (cycle-safe BFS), and pulling in the content of any `note_ref` fields as
   inline note context.

Both features extend the existing `chat:send` IPC pipeline with no new IPC channels and no
schema changes.

---

## 2. Feature 1 — `[[note]]` Mention in Chat

### 2.1 Motivation

Users often want to say "summarise this meeting note" or "what were the decisions in
`[[Project Alpha Kickoff]]`?" The `[[` trigger in the note editor already exists as a
familiar affordance. Reusing it in the chat input lets users attach a specific note to the
conversation without relying on the keyword search to surface it.

### 2.2 UX Behaviour

| Step | Trigger | Action |
|------|---------|--------|
| 1 | User types `[[` in the chat textarea | Dropdown appears below cursor showing note results |
| 2 | User continues typing (e.g. `[[Project`) | Results filtered via `notes:search` (debounced 150 ms) |
| 3 | ArrowUp/Down to navigate, Enter/click to select | `[[Project Alpha Kickoff]]` inserted; note chip appears in attachment bar |
| 4 | User can remove a note chip (×) | Note removed from context |
| 5 | User sends the message | Note IDs passed as `mentionedNoteIds` in `chat:send` |

The note chip in the attachment bar uses the same style as entity chips (`chat-mention-chip`)
but with a different colour (e.g. green, matching the `[[noteLink]]` chips in the editor) and
a document icon.

### 2.3 Data Flow

```
Renderer (ChatSidebar.vue)
  ├─ keyup handler detects /\[\[([^\]]*)$/ pattern
  ├─ debounced call: notes:search { query }
  ├─ dropdown: up to 8 note titles
  ├─ pick → insert "[[Title]]", push to mentionedNotes[]
  └─ send: chat:send { ..., mentionedNoteIds: string[] }

Main process (ipc.ts — chat:send handler)
  ├─ for each mentionedNoteId:
  │    SELECT id, title, body_plain FROM notes WHERE id = ? AND archived_at IS NULL
  ├─ build NoteContextBlock[]  (id, title, excerpt up to 4 000 chars)
  └─ pass to sendChatMessage() as new param: pinnedNotes

chat.ts — sendChatMessage()
  └─ inject pinnedNotes into system prompt under
     "## Notes pinned by user" section (before search-result context notes)
```

### 2.4 Token Budget

- Up to **5** pinned notes (enforced in renderer: no more chips allowed after 5).
- Per note: up to **4 000 chars** of `body_plain` (truncated with `…` if longer).
- Pinned notes take priority over FTS search results in the system prompt — placed first.

### 2.5 System Prompt Format

```
## Notes pinned by user
The user has explicitly attached the following notes to this conversation.
Treat them as primary source material.

### [[Project Alpha Kickoff]] [id:note-uuid-1]
<body_plain up to 4 000 chars>
---

### [[Alice 1:1 — 2025-01-15]] [id:note-uuid-2]
<body_plain up to 4 000 chars>
---
```

Notes referenced through entity fields (Feature 2) are injected in a separate section
so Claude can distinguish user intent from graph traversal.

---

## 3. Feature 2 — Deep Entity Context

### 3.1 Motivation

The current `@mention` context only injects `[id:uuid] @Name (type: Type)`. This is enough
for Claude to assign action items, but not enough to answer questions about the entity
(e.g. "what team is Alice on?", "what's Alice's email?", "who reports to her?").

We want Claude to see the entity's actual field values, resolved references, and any notes
directly linked via `note_ref` fields — all in one coherent context block.

### 3.2 Graph Traversal Rules

We use a **BFS** traversal starting from the directly mentioned entities, expanding
`entity_ref` / `entity_ref_list` fields up to **depth 2** from the root, with a
global **visited set** (entity ID) to prevent cycles (A → B → A is safe because B is
only expanded once).

```
Depth 0: directly @mentioned entities (always expanded)
Depth 1: entities referenced via entity_ref fields of depth-0 entities
Depth 2: entities referenced via entity_ref fields of depth-1 entities
         (only name + type shown, no further expansion)
```

`computed` fields are **skipped** (their values are derived at display time via WQL and
may be expensive to evaluate; Claude can ask questions instead).

`note_ref` fields are resolved at any depth: the referenced note's `body_plain` is
collected into a separate "Notes linked via entities" section in the system prompt.

### 3.3 Field Resolution

| Field type | Resolution | Injected as |
|-----------|------------|-------------|
| `text`, `email`, `date`, `select` | Raw value | `fieldName: value` |
| `text_list` | Comma-joined | `fieldName: a, b, c` |
| `entity_ref` | Fetch entity name + id | `fieldName: @Name [id:uuid]` |
| `entity_ref_list` | Fetch each entity name | `fieldName: @A [id:uuid1], @B [id:uuid2]` |
| `note_ref` | Fetch note title + collect content | `fieldName: [[Note Title]] [id:note-uuid]` |
| `computed` | Execute WQL via `parseQuery` + `evalQuery`; enqueue results if `depth < 2` | `fieldName: @A [id:uuid1], @B [id:uuid2]` (max 10) |

### 3.4 Note Token Budget (entity-linked notes)

- Up to **3** entity-linked notes injected (by order of encounter in BFS).
- Per note: up to **2 000 chars** of `body_plain` (lower budget than pinned notes).
- If a note is already a pinned note (Feature 1) it is **not duplicated** in the entity section.

### 3.5 System Prompt Format

```
## Entity context
Entities mentioned or referenced in this conversation.
Use [id:...] when assigning tasks or referencing entities.

### @Alice (Person) [id:uuid-alice]  ← directly mentioned
  role: Engineering Manager
  email: alice@example.com
  team: @Engineering [id:uuid-eng]
  manager: @Bob [id:uuid-bob]
  linked-note: [[Alice Profile]] [id:note-uuid-a]

### @Engineering (Team) [id:uuid-eng]  ← referenced via @Alice.team
  mission: Build great infrastructure
  lead: @Bob [id:uuid-bob]

### @Bob (Person) [id:uuid-bob]  ← referenced via @Alice.manager, @Engineering.lead
  role: VP Engineering
  email: bob@example.com
  (further references not expanded)

## Notes linked via entity fields
These notes were attached because they appear in entity field values.

### [[Alice Profile]] [id:note-uuid-a]
<body_plain up to 2 000 chars>
---
```

### 3.6 Updated `EntityContext` Type

Replace the current minimal type with a richer structure resolved in `ipc.ts` before
calling `sendChatMessage()`:

```typescript
// ipc.ts / chat.ts (exported from chat.ts)
export type ResolvedField = {
  name: string
  value: string          // human-readable, references formatted as @Name [id:uuid]
}

export type RichEntityContext = {
  id: string
  name: string
  type_name: string
  depth: number          // 0 = directly mentioned, 1 = 1-hop ref, 2 = 2-hop ref
  fields: ResolvedField[]
  referencedNoteIds: string[]   // note_ref field values at this entity
}

export type EntityLinkedNote = {
  id: string
  title: string
  excerpt: string        // body_plain up to 2 000 chars
}
```

The `sendChatMessage()` signature gains two new parameters (appended, backwards-compatible):

```typescript
export async function sendChatMessage(
  messages,
  contextNotes,
  calendarEvents,
  actionItems,
  images?,
  model?,
  files?,
  entityContext: RichEntityContext[] = [],      // was: EntityContext[]
  entityLinkedNotes: EntityLinkedNote[] = [],   // NEW — notes from entity fields
  pinnedNotes: EntityLinkedNote[] = [],         // NEW — user-pinned [[note]] mentions
): Promise<{ content: string; actions: ExecutedAction[] }>
```

---

## 4. Implementation Plan

### Phase A — `[[note]]` mention in chat (renderer)

- [x] **A1.** `ChatSidebar.vue` — add `noteLinkState` reactive object (parallel to existing `mentionState`):
  ```typescript
  const noteLinkState = reactive({
    active: false,
    query: '',
    startIndex: -1,
    results: [] as { id: string; title: string }[],
  })
  ```
- [x] **A2.** `ChatSidebar.vue` — extend `updateMentionState()` to also detect `/\[\[([^\]]*$)/` *after* the existing `@` check (only one trigger active at a time); debounce-call `notes:search { query }` (150 ms).
- [x] **A3.** `ChatSidebar.vue` — render a second picker dropdown `v-if="noteLinkState.active"` (reuse `.mention-picker` CSS, same keyboard ArrowUp/Down/Enter/Escape logic as entity picker).
- [x] **A4.** `ChatSidebar.vue` — implement `pickNote(note)`: replace `[[query` in `inputText` with `[[Title]]`, push to `mentionedNotes: { id, title }[]` (deduped, max 5), reset `noteLinkState`.
- [x] **A5.** `ChatSidebar.vue` — add note chips to attachment bar alongside entity chips (green background, `FileText` icon); remove button filters `mentionedNotes`.
- [x] **A6.** `ChatSidebar.vue` — include `mentionedNoteIds: mentionedNotes.map(n => n.id)` in the `chat:send` invoke payload.

### Phase B — backend note pinning (ipc.ts + chat.ts)

- [x] **B1.** `ipc.ts` — accept `mentionedNoteIds?: string[]` from `chat:send` payload.
- [x] **B2.** `ipc.ts` — after entity context fetch, query pinned notes:
  ```sql
  SELECT id, title, body_plain FROM notes
  WHERE id IN (?) AND archived_at IS NULL
  ```
  Build `pinnedNotes: EntityLinkedNote[]`, truncating `body_plain` at 4 000 chars.
- [x] **B3.** `ipc.ts` — pass `pinnedNotes` as new argument to `sendChatMessage()`.
- [x] **B4.** `chat.ts` — add `pinnedNotes: EntityLinkedNote[] = []` parameter to `sendChatMessage()`; if non-empty, prepend `## Notes pinned by user` section to system prompt.

### Phase C — rich entity context (ipc.ts + chat.ts)

- [x] **C1.** `chat.ts` — export new types: `ResolvedField`, `RichEntityContext`, `EntityLinkedNote` (replacing the current minimal `EntityContext`).
- [x] **C2.** `ipc.ts` — implement `buildRichEntityContext(db, mentionedEntityIds)` helper:
  - BFS with `visited: Set<string>` and `queue: { id, depth }[]`.
  - For each entity: fetch row + type schema; parse `schema.fields` and `entity.fields`.
  - Resolve fields by type: `entity_ref` → fetch name, enqueue if `depth < 2`; `entity_ref_list` → parse comma-sep or JSON array, same; `note_ref` → collect note id; `computed` → skip; others → raw value.
  - Collect `entityLinkedNoteIds: Set<string>` across all traversed entities.
  - Return `{ richEntities: RichEntityContext[], entityLinkedNotes: EntityLinkedNote[] }`.
- [x] **C3.** `ipc.ts` — replace the current minimal entity context query in `chat:send` with a call to `buildRichEntityContext()`; de-duplicate `entityLinkedNotes` against `pinnedNotes` by note id.
- [x] **C4.** `ipc.ts` — pass `entityLinkedNotes` as new argument to `sendChatMessage()`.
- [x] **C5.** `chat.ts` — add `entityLinkedNotes: EntityLinkedNote[] = []` parameter to `sendChatMessage()`; update system prompt to render the rich entity format (field rows, depth labels) and add `## Notes linked via entity fields` section.

### Phase D — cleanup & guard rails

- [x] **D1.** `ipc.ts` — guard `entity_ref` / `note_ref` resolution: skip if referenced entity is trashed or note is archived; show `(deleted)` / `(archived)` placeholder in field value.
- [x] **D2.** `ipc.ts` — handle `entity_ref_list` stored as either comma-separated string or JSON array (try `JSON.parse`, fall back to `.split(',')`).
- [x] **D3.** `chat.ts` — verify no duplicate note blocks between `pinnedNotes` and `entityLinkedNotes` sections in the final system prompt string.

---

## 5. Edge Cases & Guard Rails

| Scenario | Handling |
|----------|----------|
| `entity_ref` value is the entity's own ID | `visited` set prevents self-loop |
| A → B → A circular reference | BFS visited set: B is expanded once, A is already visited |
| `entity_ref` points to a trashed entity | `WHERE trashed_at IS NULL` guard; field shown as `(deleted)` |
| `note_ref` points to archived note | `WHERE archived_at IS NULL` guard; field shown as `(archived)` |
| `entity_ref_list` stored as comma-sep vs JSON array | Try `JSON.parse`; fall back to `value.split(',')` |
| No field value set | Skip field entirely (don't inject empty rows) |
| Pinned note also appears in entity `note_ref` | De-duplicate by note id before injecting |
| > 5 pinned notes | Renderer blocks adding more chips; backend also clips at 5 |
| Very long `body_plain` | Truncate at budget limit + append `…` |
| `mentionedNoteIds` contains invalid/archived IDs | SQL returns no row; silently skipped |
| No `anthropic_api_key` | Existing graceful fallback message unchanged |

---

## 6. Files Changed

| File | Change |
|------|--------|
| `src/renderer/components/ChatSidebar.vue` | Add `[[` trigger detection, `noteLinkState`, note picker dropdown, note chips in attachment bar, `mentionedNoteIds` in send payload |
| `src/main/db/ipc.ts` | Accept `mentionedNoteIds`; call `buildRichEntityContext()`; fetch pinned notes; pass all to `sendChatMessage()` |
| `src/main/embedding/chat.ts` | Update `sendChatMessage()` signature; richer system prompt sections; export new types |

No DB schema changes. No new IPC channels. No new migration files.

---

## 7. Non-Goals (for this feature)

- Recursive note content expansion (a pinned note that links to another note — not followed).
- Persisting pinned notes across chat sessions (session-only, like `mentionedEntities`).
- Showing note content previews in the chat attachment bar (title chip only).
