# Inline AI Rich Context

## Overview

The inline AI prompt in the note editor currently accepts only plain text. This feature brings it to parity with the AI chat sidebar by adding `@` entity mentions, `[[` note links, and image attachments — letting you ground inline generation in your actual knowledge base context.

## Problem

When you press `Space` on an empty line (or use the bubble menu on a selection), the AI prompt modal has no awareness of the entities, notes, or images you might want to reference. You can describe them in words, but the AI doesn't receive the structured data. This means "summarise what I know about @Sarah" produces a generic response instead of one informed by Sarah's entity fields and all related notes.

## Solution

Enhance `AIPromptModal.vue` to support the same rich input as the AI chat sidebar:

- **`@EntityName`** — autocomplete from entity index; selected entities are injected into the AI context as structured data (id, name, type, fields)
- **`[[NoteTitle]]`** — autocomplete from note titles; selected notes' full content is appended to the AI context window
- **Paste/drag images** — images forwarded to Claude as vision content blocks

Additionally, extract the shared mention/link input logic into reusable composables (`useInputMention`, `useInputNoteLink`) to eliminate duplication between `ChatSidebar.vue` and the new modal.

---

## User Experience

### @ Entity Mentions

Typing `@` inside the AI prompt textarea opens an entity picker dropdown (debounced search, keyboard navigable). Selecting an entity:
1. Inserts `@EntityName` at the cursor
2. Adds a blue `@Name · TypeName` chip to the context bar below the textarea
3. Sends the entity's id, name, type, and field values to the AI

### [[ Note Links

Typing `[[` opens a note title picker. Selecting a note:
1. Inserts `[[Note Title]]` at the cursor
2. Adds a green `[[Title]]` chip to the context bar
3. Appends the note's body (up to 800 chars) to the AI context

### Image Attachments

- **Paste** (`Cmd+V`) any image from clipboard
- **Drag and drop** an image file onto the modal
- Attached images appear as 48×48px thumbnails above the textarea with a ✕ remove button
- Images forwarded to Claude as vision content blocks (base64, JPEG/PNG/GIF/WebP)

---

## Architecture

### New Composables (reusable across the app)

```
src/renderer/composables/
  useInputMention.ts    ← @ mention state + handlers for any <textarea>
  useInputNoteLink.ts   ← [[ note link state + handlers for any <textarea>
```

These composables encapsulate the pattern currently duplicated in `ChatSidebar.vue`. Both `AIPromptModal` and `ChatSidebar` will use them.

**`useInputMention` returns:**
```ts
{
  mentionActive: Ref<boolean>
  mentionResults: Ref<EntityResult[]>
  mentionIndex: Ref<number>
  mentionedEntities: Ref<EntityResult[]>
  updateMentionState(ta: HTMLTextAreaElement, inputText: Ref<string>): void
  handleMentionKeydown(e: KeyboardEvent, ta: HTMLTextAreaElement, inputText: Ref<string>): boolean
  pickMention(entity, ta, inputText): void
  closeMention(): void
  removeMentionedEntity(id: string): void
}
```

### Modified Files

| File | Change |
|------|--------|
| `src/renderer/composables/useInputMention.ts` | **NEW** |
| `src/renderer/composables/useInputNoteLink.ts` | **NEW** |
| `src/renderer/components/AIPromptModal.vue` | Add pickers + image attach + new emit shape |
| `src/renderer/components/NoteEditor.vue` | Forward new fields from modal submit event |
| `src/renderer/components/ChatSidebar.vue` | Refactor to use composables (no behaviour change) |
| `src/main/db/ipc.ts` | Extend `notes:ai-inline` payload |
| `src/main/embedding/chat.ts` | Extend `generateInlineContent` for entity context + images |

### Data Flow

```
AIPromptModal
  │  (submit event)
  │  { prompt, mentionedEntityIds[], mentionedNoteIds[], images[] }
  ▼
NoteEditor.onAISubmit()
  │  invoke('notes:ai-inline', { prompt, noteBodyPlain, selectedText,
  │                              mentionedEntityIds, mentionedNoteIds, images })
  ▼
ipc.ts — notes:ai-inline handler
  │  DB: fetch entity fields for each mentionedEntityId
  │  DB: fetch body_plain for each mentionedNoteId → contextNotes[]
  │  Call generateInlineContent(prompt, body, selectedText,
  │       contextNotes, model, entityContext, images)
  ▼
chat.ts — generateInlineContent()
  │  System prompt: inject entity context block
  │  User message: text + image content blocks (vision)
  ▼
Claude API → Markdown → parseMarkdownToTipTap() → { content: nodes }
```

---

## Implementation Checklist

### Phase A — Shared Composables

- [ ] Create `src/renderer/composables/useInputMention.ts`
  - State: `mentionActive`, `mentionQuery`, `mentionResults`, `mentionIndex`, `mentionStart`, `mentionedEntities`
  - `updateMentionState(ta, inputText)` — detects `/@([^\s@]*)$/` at cursor, triggers 150ms debounced `entities:search`
  - `handleMentionKeydown(e, ta, inputText)` — Arrow/Enter/Escape; returns `true` if event was consumed
  - `pickMention(entity, ta, inputText)` — rewrites textarea value, pushes entity to `mentionedEntities`
  - `closeMention()`, `removeMentionedEntity(id)`
- [ ] Create `src/renderer/composables/useInputNoteLink.ts`
  - Same shape for `[[` trigger (`/\[\[([^\]]*)$/` regex), `notes:search` IPC, `mentionedNotes` (max 5)
  - `pickNote(note, ta, inputText)`, `closeNoteLink()`, `removeMentionedNote(id)`

### Phase B — AIPromptModal Enhancements

- [ ] Import `useInputMention` and `useInputNoteLink`; wire `@input` and `@keydown` on textarea
- [ ] Image attachment: `attachedImages: AttachedImage[]`, `processFile(file)`, `onPaste`, `onDrop`, `onDragover`, `onDragleave`
- [ ] Context chips bar (below textarea): entity chips, note chips, image thumbnails (48px) with ✕ buttons
- [ ] Entity picker dropdown (`v-if="mentionActive"`) — styled with `.mention-picker` / `.mention-option`
- [ ] Note link picker dropdown (`v-if="noteLinkActive"`)
- [ ] Update `onSubmit()` emit shape: `{ prompt, mentionedEntityIds: string[], mentionedNoteIds: string[], images: AttachedImage[] }`
- [ ] Drag-over visual feedback (border highlight)

### Phase C — NoteEditor Integration

- [ ] Update `onAISubmit` handler to accept `{ prompt, mentionedEntityIds, mentionedNoteIds, images }` from emit
- [ ] Pass new fields through to `window.api.invoke('notes:ai-inline', ...)`

### Phase D — IPC Handler Extension (`src/main/db/ipc.ts`)

- [ ] Extend payload type: add `mentionedEntityIds?`, `mentionedNoteIds?`, `images?`
- [ ] For each `mentionedEntityId`: query `entities` + `entity_types` → build `entityContext[]` (id, name, type_name, fields string)
- [ ] For each `mentionedNoteId`: query `notes.body_plain` (truncated 800 chars) → append to `contextNotes[]`
- [ ] Forward `images` and `entityContext` to `generateInlineContent`

### Phase E — `generateInlineContent` Enhancement (`src/main/embedding/chat.ts`)

- [ ] Add `entityContext?: { id: string; name: string; type_name: string; fields?: string }[]` param
- [ ] Add `images?: { dataUrl: string; mimeType: string }[]` param
- [ ] Inject entity context into system prompt (same format as `chat:send`)
- [ ] Build multipart user message when images present: `[{ type: 'image', ... }, { type: 'text', ... }]`
- [ ] Strip `data:image/...;base64,` prefix → raw base64 for Anthropic API

### Phase F — ChatSidebar Refactor

- [ ] Replace @ mention state/logic in `ChatSidebar.vue` with `useInputMention`
- [ ] Replace [[ note link state/logic with `useInputNoteLink`
- [ ] Verify session entity/note lists and all keyboard nav still work identically
- [ ] Run `npm run typecheck` — no errors

---

## Verification

1. **Inline AI basic**: `Space` on empty line → modal opens, submit generates content — unchanged behaviour
2. **@ entity in modal**: type `@` → dropdown; select entity → chip appears; submit → AI response informed by entity fields
3. **[[ note in modal**: type `[[` → note picker; select note → chip; submit → AI has note content as context
4. **Images**: paste or drag image → thumbnail; submit → Claude vision API receives it
5. **Bubble menu (replace mode)**: same enrichment available in selection-replace flow
6. **ChatSidebar parity**: `@` and `[[` in chat textarea work identically after refactor
7. **Typecheck**: `npm run typecheck` passes with zero errors