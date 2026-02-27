# Feature: AI-Generated Rich Mentions & Note Links

## Context

When the AI generates content — in the chat sidebar, in the inline AI modal, or in post-meeting summaries
— it can refer to entities (`@Alice`) or notes (`[[Sprint Notes]]`). Currently these tokens land as plain,
unclickable text, breaking the note's interactive layer and making context harder to navigate.

This feature ensures that every AI surface that can produce `@EntityName` or `[[NoteTitle]]` output
automatically renders them as first-class interactive elements, identical in appearance and behaviour to
hand-typed @mentions and [[note-links]].

---

## Surfaces

| Surface | Today | After |
|---------|-------|-------|
| Chat sidebar | AI mentions `@Alice` as plain text | Blue clickable chip (same style as `MentionChip`) |
| Chat sidebar | `[[Sprint Notes]]` as plain text | Green clickable chip (same style as `NoteLinkChip`) |
| Notes — inline AI | `@Alice` inserted as plain text | TipTap `mention` node (full chip + popup) |
| Notes — inline AI | `[[Sprint Notes]]` inserted as plain text | TipTap `noteLink` node (full chip + popup) |
| Post-meeting summary | Entity/note names as plain text | Same as notes inline AI path |
| Daily Brief | Names as plain text | Entity/note chips in rendered HTML |

---

## Design Principles

- **Consistency first.** `@` and `[[` tokens must look and behave identically however they were created
  (hand-typed, AI-generated, pasted).
- **Graceful degradation.** If a name cannot be resolved to an ID (entity not in DB, note deleted,
  DB error), the text renders as plain text — no crash, no broken nodes.
- **Reuse existing abstractions.** TipTap `mention`/`noteLink` nodes and `MentionChip`/`NoteLinkChip`
  components are the canonical representation; this feature feeds into them, not around them.
  In chat, the existing placeholder-before-markdown strategy in `renderMessage()` is extended, not replaced.

---

## Data Flow

### Surface 1 — Notes (inline AI → TipTap nodes)

```
AIPromptModal (prompt + @mentions + [[links])
  → notes:ai-inline IPC
      → generateInlineContent() → Markdown string (may contain @Name, [[Title]])
      → scan Markdown for @Name / [[Title]] patterns
      → batch DB lookup: entities by name, notes by title
      → build ParseContext { resolveEntity, resolveNote }
      → parseMarkdownToTipTap(markdown, context)
          └─ parseInlineMarkdown(text, context)
               ├─ @Name → { type:'mention', attrs:{id, label} }   (if resolved)
               ├─ [[Title]] → { type:'noteLink', attrs:{id, label} }  (if resolved)
               └─ plain text fallback if unresolved
  → TipTap nodes inserted into editor
```

### Surface 2 — Chat sidebar

```
User message
  → chat:send IPC
      → sendChatMessage(messages, ..., entityContext[])
          → Claude response text (may contain @Name, [[Title]])
          → scan response for @Name patterns
          → resolve against entityContext[] already in scope → entityRefs[]
          → scan response for [[Title]] patterns
          → resolve against references[] (notes cited by Claude)
          → return { content, references, entityRefs, actions }
  → chatStore ChatMessage stores { content, references, entityRefs }
  → ChatSidebar renderMessage(content, references, entityRefs)
      ├─ placeholder-before-markdown strategy (extend existing)
      ├─ @Name → <button class="chat-entity-ref" data-entity-id data-entity-name>
      ├─ [[Title]] → <button class="chat-note-ref" ...>  (existing style, new pattern)
      └─ onBubbleClick handles data-entity-id → openEntity() with all 3 open modes
```

---

## System Prompt Changes

Both `sendChatMessage()` and `generateInlineContent()` system prompts are extended with:

```
When referencing an entity (person, project, team, decision, OKR) that was provided in your
context, write its name as @EntityName. When referencing a note by title, write it as
[[Note Title]]. These will be rendered as interactive chips in the UI.
```

This keeps the existing `[Note: "Title"]` citation format for knowledge-base search references and
adds `@` / `[[]]` as the preferred syntax for in-prose entity and note references.

---

## Architecture Changes

### `src/main/transcription/postProcessor.ts`

- Add `ParseContext` interface (exported):
  ```ts
  export interface ParseContext {
    resolveEntity?: (name: string) => { id: string; label: string } | null
    resolveNote?:   (title: string) => { id: string; label: string } | null
  }
  ```
- `parseInlineMarkdown(text, ctx?: ParseContext)`: add patterns for `@Name` and `[[Title]]`;
  emit `{ type:'mention', attrs:{id, label} }` / `{ type:'noteLink', attrs:{id, label} }` when
  resolved; emit plain text node when unresolved.
- Change return type of `parseInlineMarkdown()` from `TipTapTextNode[]` to `TipTapNode[]`
  (superset — all existing callers handle this transparently).
- `parseMarkdownToTipTap(markdown, ctx?: ParseContext)`: thread `ctx` through to
  `parseInlineMarkdown()`. Omitting `ctx` preserves existing plain-text behaviour.

### `src/main/db/ipc.ts` — `notes:ai-inline` handler

- After `generateInlineContent()` returns Markdown: scan for `@Name` and `[[Title]]` tokens.
- Batch-query DB:
  - Entities: `SELECT id, name FROM entities WHERE name IN (?) AND trashed_at IS NULL`
  - Notes: `SELECT id, title FROM notes WHERE title IN (?) AND archived_at IS NULL`
- Build `ParseContext` and pass to `parseMarkdownToTipTap()`.

### `src/main/transcription/postProcessor.ts` — `updateNoteWithTranscript()`

- Build a `ParseContext` using the DB reference already available in `postProcessor.ts`.
- Pass to `parseMarkdownToTipTap()` so transcript AI summaries also produce interactive chips.

### `src/main/embedding/chat.ts`

- `sendChatMessage()` system prompt: add `@EntityName` / `[[NoteTitle]]` instruction.
- `generateInlineContent()` system prompt: same addition.
- In `sendChatMessage()`: after the tool-use loop, scan `finalContent` for `@Name` patterns;
  cross-reference against the `entityContext` / `richEntities` already in scope;
  build `entityRefs: { id, name }[]`.
- Return type: add `entityRefs: { id: string; name: string }[]` to the return object.

### `src/renderer/stores/chatStore.ts`

- Add `entityRefs?: { id: string; name: string }[]` to `ChatMessage`.

### `src/renderer/components/ChatSidebar.vue`

- `renderMessage(content, references, entityRefs?)`:
  - Extend the placeholder strategy with two new passes before `marked.parse()`:
    - `@Name` → `WIZZENT{i}WIZZENT`
    - `[[Title]]` → `WIZZLINK{i}WIZZLINK`
  - After `marked.parse()`, substitute placeholders:
    - Entity → `<button class="chat-entity-ref" data-entity-id="..." data-entity-name="...">@Name</button>`
    - Note → existing `<button class="chat-note-ref" ...>` (reuse unchanged style)
- `onBubbleClick()`: detect `data-entity-id` → call `openEntity(e, entityId)` (all 3 open modes).
- Wire `open-entity` emit (already exists on the component).
- CSS: add `.chat-entity-ref` matching `MentionChip` blue styling (see below).

### `src/renderer/components/TodayView.vue` — Daily Brief

- In `markdownToHtml()`: add passes for `@Name` and `[[Title]]` using the same placeholder
  strategy (before `marked.parse()`), substituting with typed buttons post-parse.
- Wire event delegation click handler on the brief container.
- Emit `open-entity` / `open-note` to `App.vue`.

---

## Shared CSS

```css
/* Entity mention chip in AI-generated HTML surfaces (chat, daily brief) */
.chat-entity-ref {
  display: inline-flex;
  align-items: center;
  background: #dbeafe;          /* matches MentionChip background */
  color: #1e40af;
  border: none;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  margin: 0 1px;
}
.chat-entity-ref:hover {
  background: #bfdbfe;
}
```

The existing `.chat-note-ref` style in `ChatSidebar.vue` is reused unchanged for `[[NoteTitle]]` chips.

---

## Implementation Checklist

### Phase A — Extend `parseMarkdownToTipTap` for inline mention/nodeLink nodes
- [x] Export `ParseContext` interface from `postProcessor.ts`
- [x] Extend `parseInlineMarkdown(text, ctx?)` to match `@Name` and `[[Title]]` inline tokens
- [x] Emit `mention` / `noteLink` TipTap nodes when resolved; plain text when not
- [x] Change `parseInlineMarkdown()` return type to `TipTapNode[]`
- [x] Update `parseMarkdownToTipTap(markdown, ctx?)` to accept and pass through `ParseContext`
- [x] Confirm all existing callers still compile (omitted `ctx` = plain text degradation)

### Phase B — Inline AI path: resolve mentions before node insertion
- [x] In `notes:ai-inline` handler (`ipc.ts`): scan generated Markdown for `@Name` / `[[Title]]` patterns
- [x] Batch-query DB for entities by name and notes by title
- [x] Build `ParseContext` and pass to `parseMarkdownToTipTap()`
- [ ] Verify `@Alice` in AI-generated inline content becomes a clickable `MentionChip` in the editor

### Phase C — Post-meeting summary path
- [x] In `postProcessor.ts` `updateNoteWithTranscript()`: build a `ParseContext` using the available DB reference
- [x] Pass to `parseMarkdownToTipTap()` so transcript AI summaries produce interactive chips
- [ ] Test: generate a post-meeting summary naming an attendee → chip appears in the note

### Phase D — Chat path: AI response entity chips
- [x] Update `sendChatMessage()` system prompt to instruct `@EntityName` / `[[NoteTitle]]` usage
- [x] After tool-use loop: scan response text for `@Name`, resolve against `entityContext` / `richEntities`
- [x] Add `entityRefs: { id, name }[]` to `sendChatMessage()` return type and `chat:send` IPC response
- [x] Add `entityRefs?: { id: string; name: string }[]` to `ChatMessage` in `chatStore.ts`
- [x] In `ChatSidebar.vue` `renderMessage()`: add placeholder passes for `@Name` → entity button and
  `[[Title]]` → note button; substitute after `marked.parse()`
- [x] Add `.chat-entity-ref` CSS (blue chip matching `MentionChip`)
- [x] Extend `onBubbleClick()` to handle `data-entity-id` → `openEntity()` (all 3 open modes)
- [ ] Verify `@Alice` in chat response becomes a blue chip that opens Alice's entity page

### Phase E — `generateInlineContent` system prompt
- [x] Update `generateInlineContent()` system prompt to instruct `@EntityName` / `[[NoteTitle]]` usage
- [ ] Test: ask inline AI "write a summary mentioning @Alice" → chip appears in the note

### Phase F — Daily Brief (TodayView)
- [x] In `TodayView.vue` `markdownToHtml()`: add placeholder passes for `@Name` and `[[Title]]`
- [x] Wire event delegation click handler on the brief container
- [x] Emit `open-entity` / `open-note` from `TodayView` to `App.vue`
- [ ] Test: generate a Daily Brief containing entity names → chips appear and open correctly

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| `@` in email addresses or code matched as entity mention | Regex anchored: `@` must be preceded by whitespace or start-of-string, and followed by a capital letter or digit |
| Two entities with same name | Resolve to first non-trashed match; Claude's context already uses canonical `[id:uuid]` and can be instructed to prefer the bracketed form |
| Very long entity names in patterns | Cap pattern match at 60 chars to avoid runaway greedy matches |
| `parseInlineMarkdown` return type change | `TipTapNode` is a strict superset of `TipTapTextNode`; all callers use the result as `TipTapNode[]` already |
| Unresolved names produce no node | Graceful fallback to plain text — existing content is never corrupted |
