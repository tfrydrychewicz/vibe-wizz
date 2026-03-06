# Note Selection Context — Paste Note Selections as Rich Context Attachments

## Overview

When a user selects content in the note editor, copies it, and pastes into the AI Chat sidebar or an inline AI prompt, instead of inserting raw text Wizz captures the selection as a **structured context attachment**: a compact chip displaying the note title and block range (e.g. `≡ Meeting Notes (blocks 5–12)`). When the prompt is submitted, the model receives the full content of that selection — including task nodes, mentions, headings, and list structure — as an explicitly labelled context block.

This mirrors Cursor's file-context chips (`IDEAS.md (5-12)`) but adapted to Wizz's note-centric world: the unit is a note + block range, and the rich content (action items, entity mentions, etc.) is always included in full in the AI context even though only a chip is shown in the UI.

---

## Motivating Use Cases

| Scenario | How it works |
|----------|-------------|
| **Tasks → Project** | User selects a bullet list of tasks in a note, pastes into chat, asks "create and attach a project for these tasks" — AI creates a project entity and links each task's action item to it |
| **Tasks not yet action items** | The new `ensure_action_item_for_task` tool creates a missing action item before updating it, so the AI can operate on tasks that haven't been formally extracted yet |
| **Decisions → Entity** | User pastes a section of decisions from a note, asks "create a Decision entity for each of these" — AI has the full structured text |
| **Context for inline AI** | User pastes a selection from a related note into the inline AI prompt for richer, cross-note generation |

---

## Core Concepts

| Term | Meaning |
|------|---------|
| **Note Selection** | A user-selected range of content from a note, identified by note ID + title + block range + serialised plain text |
| **Selection chip** | Compact `≡ Note Title (blocks X–Y)` pill shown in the chat/prompt input area |
| **Block line** | A top-level block node in the TipTap document (paragraph, heading, list item, task item, etc.); used as the unit for range computation |
| **Selection context block** | The formatted string injected into the AI system/user prompt when a selection attachment is present |
| `ensure_action_item_for_task` | New WIZZ_TOOL: finds or creates an `action_items` row for a task described in pasted note content |

---

## Data Model

No new database tables required. All state is transient (in-memory, per-session in the renderer).

### Shared TypeScript Type (new file `src/renderer/types/noteSelection.ts`)

```typescript
/** A note selection attachment — created from clipboard data on paste */
export interface NoteSelectionAttachment {
  /** Source note's ULID */
  noteId: string
  /** Source note's title at copy time */
  noteTitle: string
  /** 1-based start block index in the TipTap document */
  blockStart: number
  /** 1-based end block index in the TipTap document */
  blockEnd: number
  /** Plain-text rendering of the selected content (includes task markers, mentions, etc.) */
  selectedText: string
}
```

### Clipboard Format

A custom MIME type written alongside `text/plain` on every copy from NoteEditor:

```
MIME type: application/x-wizz-note-selection
Payload:   JSON string of NoteSelectionAttachment
```

The `text/plain` fallback is kept so copies still work in external apps.

---

## Copy Side — NoteEditor Integration

### Block-Range Computation

TipTap documents consist of top-level **block nodes** (paragraphs, headings, bullet list items, task items, code blocks, etc.). To compute a human-readable range:

1. Walk `editor.state.doc.descendants()` collecting each top-level block node and its `pos`
2. Find the first block whose pos range overlaps `selection.from` → `blockStart`
3. Find the last block whose pos range overlaps `selection.to` → `blockEnd`
4. Serialize only the selected slice to plain text via `editor.state.doc.slice(from, to).content.textBetween(0, ..., '\n')`

### Copy Handler in `NoteEditor.vue`

```typescript
// Wired to the editor's DOM via @copy on the `.note-body` container
function onEditorCopy(e: ClipboardEvent): void {
  if (!props.noteId || !noteTitle.value) return
  const { from, to, empty } = editor.value!.state.selection
  if (empty) return  // nothing selected — let default copy proceed

  const attachment = buildNoteSelectionAttachment(
    editor.value!,
    props.noteId,
    noteTitle.value,
    from,
    to,
  )
  if (!attachment) return

  // Write structured data alongside normal text/plain so external paste still works
  e.clipboardData?.setData('application/x-wizz-note-selection', JSON.stringify(attachment))
  // Do NOT call e.preventDefault() — let TipTap write text/plain normally
}
```

### `buildNoteSelectionAttachment` utility (`src/renderer/utils/noteSelection.ts`)

Single function exported from a new dedicated utility — importable by NoteEditor without circular deps:

```typescript
import type { Editor } from '@tiptap/core'
import type { NoteSelectionAttachment } from '../types/noteSelection'

export function buildNoteSelectionAttachment(
  editor: Editor,
  noteId: string,
  noteTitle: string,
  from: number,
  to: number,
): NoteSelectionAttachment | null

export function formatNoteSelectionForPrompt(attachment: NoteSelectionAttachment): string
```

`formatNoteSelectionForPrompt` returns:

```
--- Note Selection: "Meeting Notes" (blocks 5–12) ---
- [ ] Write retro doc
- [ ] Schedule infra review  @Bartek
- [x] Share Q1 metrics
---
```

---

## Paste Side — Shared Composable

### `useNoteSelectionPaste` (`src/renderer/composables/useNoteSelectionPaste.ts`)

Follows the same module-level composable pattern as `useFileAttachment`, `useInputMention`, etc.

```typescript
export function useNoteSelectionPaste() {
  const attachedSelections = ref<NoteSelectionAttachment[]>([])

  /** Call from onPaste handler BEFORE the file-attachment composable */
  function onPaste(e: ClipboardEvent): boolean {
    // Returns true if the event was handled (prevents default text paste)
    const raw = e.clipboardData?.getData('application/x-wizz-note-selection')
    if (!raw) return false
    try {
      const attachment = JSON.parse(raw) as NoteSelectionAttachment
      attachedSelections.value.push(attachment)
      e.preventDefault()
      return true
    } catch {
      return false
    }
  }

  function removeSelection(index: number): void {
    attachedSelections.value.splice(index, 1)
  }

  function clear(): void {
    attachedSelections.value = []
  }

  return { attachedSelections, onPaste, removeSelection, clear }
}
```

**Integration order in paste handlers**: call `useNoteSelectionPaste().onPaste(e)` first; only call `useFileAttachment().onPaste(e)` if it returned `false`. This ensures Wizz-clipboard data is intercepted before the generic file/image paste path.

---

## UI — `NoteSelectionChip.vue`

A reusable component rendered in both `ChatSidebar` and `AIPromptModal` inside the existing attachment bar area.

```
┌─────────────────────────────────────┐
│  ≡  Meeting Notes  (blocks 5–12)  × │
└─────────────────────────────────────┘
```

**Props:**
- `attachment: NoteSelectionAttachment`
- `onRemove: () => void`

**Styling:** Matches existing attachment chip style (`AttachmentBar`). Uses `AlignLeft` (Lucide) as the leading icon. Background: `var(--color-accent-subtle)`. Border: `1px solid var(--color-border)`. Same height/font as `AttachmentBar` file chips.

**Placement in both surfaces:**
- In `ChatSidebar`: rendered above the `AttachmentBar` (note selections logically precede file attachments in the context hierarchy)
- In `AIPromptModal`: rendered in the same pre-input attachment zone, after existing attachment chips

Since both surfaces already have an attachment zone (via `AttachmentBar`), note selection chips are added in the same flex container via a `v-for` over `attachedSelections`.

---

## AI Chat Integration

### `chatStore` Extension

```typescript
// Add to ChatMessage type in chatStore.ts
noteSelections?: NoteSelectionAttachment[]  // selections attached at send time
```

Each `ChatMessage` for the user turn records which selections were attached, so the conversation history correctly reflects what context was sent.

### `chat:send` IPC Extension

```typescript
// New field in the invoke payload
noteSelections?: { noteId: string; noteTitle: string; blockStart: number; blockEnd: number; selectedText: string }[]
```

### `sendChatMessage()` in `chat.ts`

The selected text is injected into the **user message content** (not system prompt), as an explicitly-labelled fenced block prepended before the user's typed message:

```
<note_selections>
--- Note Selection: "Meeting Notes" (blocks 5–12) ---
- [ ] Write retro doc
- [ ] Schedule infra review  @Bartek
- [x] Share Q1 metrics
---
</note_selections>

[user's typed message here]
```

This approach:
- Keeps the system prompt clean
- Puts selection content at conversation-context scope where Claude processes it naturally
- Is consistent with how images and files are attached (content blocks on the user message)

---

## Inline AI Integration

### `AIPromptSubmit` Extension

```typescript
export interface AIPromptSubmit {
  prompt: string
  mentionedEntityIds: string[]
  mentionedNoteIds: string[]
  images: { ... }[]
  files: { ... }[]
  model: string
  noteSelections: NoteSelectionAttachment[]   // NEW
}
```

### `notes:ai-inline` IPC Handler

Extend the `generateInlineContent()` call to prepend formatted note selections to the prompt context, same format as the chat path.

---

## New WIZZ_TOOL: `ensure_action_item_for_task`

### Problem

When a user pastes a task list from a note and asks "attach a project to these tasks", many of those tasks may be raw list items that have never been promoted to `action_items` rows. The existing `update_action_item` tool requires a known action item ID. A new tool bridges this gap: find or create the action item, then return its ID so other tools can act on it.

### Tool Definition

```typescript
{
  name: 'ensure_action_item_for_task',
  description: `Find or create an action item for a specific task from a pasted note selection.
Use this when the user asks to modify a task (assign project, set status, etc.) that came
from a pasted note selection and may not yet have a corresponding action item.
Returns the action item ID; then use update_action_item with that ID.`,
  input_schema: {
    type: 'object',
    properties: {
      task_text: {
        type: 'string',
        description: 'The task title as it appears in the note selection (verbatim or close match)',
      },
      source_note_id: {
        type: 'string',
        description: 'The note ID from which the task was pasted (available from the selection context)',
      },
    },
    required: ['task_text', 'source_note_id'],
  },
}
```

### Tool Execution (in `chat.ts` tool dispatch)

```
1. SELECT * FROM action_items
   WHERE source_note_id = $source_note_id
     AND title LIKE '%' || $task_text || '%'
     AND status != 'cancelled'
   LIMIT 1

2. If found → return { action_item_id, created: false, title }

3. If not found → call action-items:create logic directly:
   INSERT INTO action_items (id, title, source_note_id, extraction_type, status, created_at, updated_at)
   VALUES (ulid(), $task_text, $source_note_id, 'manual', 'open', now(), now())
   → return { action_item_id, created: true, title }
```

### Tool Result Shape

```typescript
{
  action_item_id: string  // ULID of found or created action item
  created: boolean        // true if newly created
  title: string           // final title stored
}
```

After calling this tool, Claude should immediately call `update_action_item` with the returned `action_item_id` to apply the requested change (assign project, set status, etc.).

### System Prompt Hint

The system prompt is extended with:

```
When the user asks to modify a task from a pasted note selection (e.g. assign a project,
set status, add to a project), always call ensure_action_item_for_task first to obtain the
action item ID, then call update_action_item. Do not call update_action_item without a
verified action_item_id.
```

---

## Preload / IPC Surface

`src/preload/index.ts` already exposes `window.api.invoke`. The new fields are transparent: `chat:send` and `notes:ai-inline` payloads are extended with `noteSelections` — no new IPC channels required.

---

## Example End-to-End Flow

```
User selects 3 task bullets in "Q2 Planning" note (blocks 7–9)
  → Copies (Cmd+C)
  → Clipboard: text/plain + application/x-wizz-note-selection JSON

User opens AI Chat (Cmd+J)
  → Pastes (Cmd+V)
  → ChatSidebar: useNoteSelectionPaste intercepts
  → Chip appears: "≡ Q2 Planning (blocks 7–9) ×"

User types: "Create a project for these tasks and link them all to it"
  → Sends

chat:send IPC payload:
  messages: [...]
  noteSelections: [{ noteId, noteTitle: "Q2 Planning", blockStart: 7, blockEnd: 9,
                     selectedText: "- [ ] Define scope\n- [ ] Write RFC\n- [ ] Kickoff call" }]

chat.ts prepends to user message:
  <note_selections>
  --- Note Selection: "Q2 Planning" (blocks 7–9) ---
  - [ ] Define scope
  - [ ] Write RFC
  - [ ] Kickoff call
  ---
  </note_selections>

  Create a project for these tasks and link them all to it

Claude tool calls:
  1. create_project({ name: "Q2 Planning Project", status: "active" })
     → { id: "proj-uuid", name: "Q2 Planning Project" }
  2. ensure_action_item_for_task({ task_text: "Define scope", source_note_id: "note-uuid" })
     → { action_item_id: "ai-1", created: true }
  3. update_action_item({ id: "ai-1", project_entity_id: "proj-uuid" })
  4. ensure_action_item_for_task({ task_text: "Write RFC", source_note_id: "note-uuid" })
     → { action_item_id: "ai-2", created: true }
  5. update_action_item({ id: "ai-2", project_entity_id: "proj-uuid" })
  6. ensure_action_item_for_task({ task_text: "Kickoff call", source_note_id: "note-uuid" })
     → { action_item_id: "ai-3", created: false }  // already existed
  7. update_action_item({ id: "ai-3", project_entity_id: "proj-uuid" })

Claude final response:
  "Done! I created the project **Q2 Planning Project** and linked all 3 tasks to it.
   (The 'Kickoff call' task was already tracked as an action item.)"

Action cards rendered:
  ✅ Created entity — Q2 Planning Project   [Open in Entities →]
  ✅ Updated action item — Define scope
  ✅ Updated action item — Write RFC
  ✅ Updated action item — Kickoff call
```

---

## Implementation Checklist

### Phase A — Shared Types & Utilities

- [x] Create `src/renderer/types/noteSelection.ts` — export `NoteSelectionAttachment` interface and `NOTE_SELECTION_MIME` constant
- [x] Create `src/renderer/utils/noteSelection.ts` — export `buildNoteSelectionAttachment(editor, noteId, noteTitle, from, to)`, `formatNoteSelectionForPrompt(attachment)`, and `formatNoteSelectionsForPrompt(attachments)`
  - `buildNoteSelectionAttachment`: walks `editor.state.doc` top-level block nodes, finds overlap with `[from, to]`, computes 1-based `blockStart`/`blockEnd`, serializes slice to plain text (task items rendered as `- [ ]`/`- [x]`, lists as `- `, headings with `#`, code blocks with fences)
  - `formatNoteSelectionForPrompt`: returns fenced markdown block with header line
  - `formatNoteSelectionsForPrompt`: wraps multiple attachments in `<note_selections>` XML block for prompt injection

### Phase B — Copy Interception in `NoteEditor.vue`

- [x] Add `@copy="onEditorCopy"` handler on `.note-body` container element
- [x] Implement `onEditorCopy(e: ClipboardEvent)`: guard on non-empty selection + `props.noteId` + `title.value`; call `buildNoteSelectionAttachment`; write `NOTE_SELECTION_MIME` JSON to `e.clipboardData` without preventing default (so `text/plain` is also written by TipTap)

### Phase C — `useNoteSelectionPaste` Composable

- [x] Create `src/renderer/composables/useNoteSelectionPaste.ts`
  - `attachedSelections: Ref<NoteSelectionAttachment[]>`
  - `onPaste(e: ClipboardEvent): boolean` — reads `NOTE_SELECTION_MIME`, validates payload shape, pushes to list, calls `e.preventDefault()`, returns `true`; returns `false` if MIME type absent or payload malformed
  - `removeSelection(index: number): void`
  - `clear(): void`

### Phase D — `NoteSelectionChip.vue` Component

- [x] Create `src/renderer/components/NoteSelectionChip.vue`
  - Props: `attachment: NoteSelectionAttachment`, optional `removable?: boolean`, emits `remove`
  - Render: `AlignLeft` Lucide icon + `attachment.noteTitle` + `(blocks X–Y)` range span + conditional `×` remove button (hidden when `removable === false`, for use in conversation history)
  - `title` attribute set to `attachment.selectedText` for hover preview
  - No `<style scoped>` — all CSS in `style.css` as `.wizz-note-selection-chip` + BEM modifier classes matching the `attachment-file` chip look from `AttachmentBar`

### Phase E — `ChatSidebar.vue` Integration

- [x] Import and wire `useNoteSelectionPaste` composable; renamed `useFileAttachment.onPaste` to `onFilePaste` to avoid collision; wrapped in `onPaste(e)` that checks note selection first
- [x] Chain paste handler: `onNoteSelectionPaste(e)` checked first; falls through to `onFilePaste(e)` when no Wizz clipboard data present; `@paste="onPaste"` on textarea unchanged
- [x] Render `NoteSelectionChip` for each `attachedSelections` entry above `AttachmentBar` in the chat-attachments-bar; `v-if` condition extended to include `attachedSelections.length > 0`
- [x] Extend `send()` to capture `selectionsToSend`, pass as `noteSelections` in `chat:send` IPC payload, store in `userMsg.noteSelections`; enabled send when selections present even with empty text
- [x] `clearSelections()` called before pushing to `messages` so chips are cleared optimistically
- [x] Extend `ChatMessage` in `chatStore.ts` with `noteSelections?: NoteSelectionAttachment[]`; re-exported via `export type { NoteSelectionAttachment }` from chatStore
- [x] Render non-removable selection chips in conversation history via `chat-msg-selections` flex container + `<NoteSelectionChip :removable="false" />`; send button `:disabled` extended to also check `attachedSelections.length`

### Phase F — `AIPromptModal.vue` Integration

- [x] Import and wire `useNoteSelectionPaste` composable; renamed `useFileAttachment.onPaste` → `onFilePaste`; wrapper `onPaste(e)` checks note selection first
- [x] Chain paste handler: `onNoteSelectionPaste(e)` first; falls through to `onFilePaste(e)`; `@paste="onPaste"` on textarea unchanged
- [x] Render `NoteSelectionChip` entries inside `.ai-modal-context` div after `AttachmentBar`; `hasContext()` extended to include `attachedSelections.value.length > 0`
- [x] Extend `AIPromptSubmit` interface: added `noteSelections: NoteSelectionAttachment[]`
- [x] `doSubmit()` emits `noteSelections: [...attachedSelections.value]`; Generate button `:disabled` extended to include `attachedSelections.length === 0`
- [x] `NoteEditor.vue` `onAIPromptSubmit()`: forwards `payload.noteSelections` as `noteSelections` in the `notes:ai-inline` IPC payload (omitted when empty)

### Phase G — `chat:send` IPC Handler Extension

- [x] Exported `NoteSelectionAttachment` type from `chat.ts` (mirrors renderer type; kept separate because main-process tsconfig excludes renderer sources); imported into `ipc.ts`
- [x] Extended `chat:send` handler payload type with `noteSelections?: NoteSelectionAttachment[]`; passed through to `sendChatMessage()` as last arg (defaults to `[]`)
- [x] Added `formatNoteSelectionsBlock()` private helper in `chat.ts`; called in `loopMessages` build — prepends `<note_selections>…</note_selections>` block to the last user message text (works alongside existing image/file content blocks; plain text path also covered)
- [x] Added system prompt instruction: "ALWAYS call `ensure_action_item_for_task` first to obtain the action item ID before calling `update_action_item` for tasks from pasted note selections"

### Phase H — `notes:ai-inline` IPC Handler Extension

- [x] Extended `notes:ai-inline` handler payload type with `noteSelections?: NoteSelectionAttachment[]`; passed to `generateInlineContent()` with `?? []` fallback
- [x] Extended `generateInlineContent()` signature with `noteSelections: NoteSelectionAttachment[] = []` param; reuses `formatNoteSelectionsBlock()` from Phase G to prepend the `<note_selections>` block to `userText` before the instructions — works correctly for both insert mode and replace (rewrite) mode

### Phase I — New WIZZ_TOOL: `ensure_action_item_for_task`

- [x] Add `ensure_action_item_for_task` tool definition to `WIZZ_TOOLS` array in `chat.ts`
  - Input: `{ task_text: string, source_note_id: string }`
  - Description includes guidance to call before `update_action_item` when operating on tasks from pasted selections
- [x] Implement tool execution in the tool-dispatch block of `chat.ts`:
  - `SELECT * FROM action_items WHERE source_note_id = ? AND title LIKE '%'||?||'%' AND status != 'cancelled' LIMIT 1`
  - If not found: generate UUID, `INSERT INTO action_items(...)`, stamp `created_at` and `updated_at`
  - Return `{ action_item_id, created, title }`
- [x] Add `'ensured_action_created'` / `'ensured_action_found'` types to `ExecutedAction` union in `chat.ts` and `chatStore.ts`
- [x] Render action card for ensured actions in `ChatSidebar.vue` (green for created, blue for found-existing)

### Phase J — Preload Bridge

- [x] Verify that `window.api.invoke('chat:send', payload)` in `src/preload/index.ts` passes the payload through without stripping unknown keys — confirmed: `invoke` is typed as `(channel, data?: unknown) => ipcRenderer.invoke(channel, data)`, a fully generic passthrough; no change needed
- [x] Same check for `notes:ai-inline` — same passthrough; no change needed

### Phase K — Documentation & CLAUDE.md Update

- [x] Update `CLAUDE.md`:
  - New types: `NoteSelectionAttachment` in `src/renderer/types/noteSelection.ts`
  - New utilities: `buildNoteSelectionAttachment`, `formatNoteSelectionForPrompt` in `src/renderer/utils/noteSelection.ts`
  - New composable: `useNoteSelectionPaste` in `src/renderer/composables/useNoteSelectionPaste.ts`
  - New component: `NoteSelectionChip.vue`
  - `chat:send` payload extended with `noteSelections`; WIZZ_TOOL count updated to 8
  - `notes:ai-inline` extended with `noteSelections`
  - New WIZZ_TOOL: `ensure_action_item_for_task`
  - New `ExecutedAction` types: `ensured_action_created`, `ensured_action_found`
  - `NoteEditor.vue` note selection copy integration documented
- [x] `DESIGN.md` / feature docs: full design captured in `features/NOTE_SELECTION_CONTEXT.md`; all phases A–K checked off

---

## Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| **Custom MIME type, not a special text prefix** | Reliable detection; doesn't corrupt external paste; carries structured metadata without heuristics |
| **Block-level (not character-level) line numbering** | TipTap documents don't have stable character lines; block nodes are the natural semantic unit and correspond to what users see as "lines" |
| **selectedText in clipboard payload, not re-fetched via IPC** | Avoids round-trip; content is known at copy time; note may have changed by send time (edge case) |
| **Content in user message, not system prompt** | Selection content is conversational context, not standing instructions; placing it in the user turn is idiomatic for Claude |
| **`ensure_action_item_for_task` as a WIZZ_TOOL** | Keeps the upsert logic server-side (access to DB); Claude decides when to call it; avoids a new IPC channel; consistent with existing tool pattern |
| **No new DB tables** | All state is session-scoped and ephemeral; selections are attached at send time, not persisted |
| **`useNoteSelectionPaste` as a composable (not inline in each component)** | Ensures identical paste behaviour in `ChatSidebar` and `AIPromptModal`; consistent with existing `useFileAttachment`, `useInputMention`, `useInputNoteLink` pattern |
| **`NoteSelectionChip` as a reusable component** | Both surfaces render identical chips; enforces visual consistency; style rules in `style.css` only |
