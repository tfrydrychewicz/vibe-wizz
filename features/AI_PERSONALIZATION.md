# AI Personalization — User Preamble for Every AI Prompt

## Overview

Users can write a rich description of themselves — their role, team, working style, preferences, and priorities — using the same `RichTextInput` component already used in AI chat. This preamble is automatically prepended to **every AI system prompt** across the app: chat, inline AI generation, daily briefs, entity reviews, and meeting summaries. The result is an AI that already knows who it is talking to without the user having to re-introduce themselves on every query.

---

## Motivating Use Cases

| Scenario | Without personalization | With personalization |
|----------|------------------------|---------------------|
| AI Chat | "Who am I talking to?" context lost | Wizz knows you are a VP Eng leading 3 teams |
| Daily Brief | Generic summary | Prioritises your OKRs + direct reports' blockers |
| Inline generation | Writes for a generic audience | Writes for an engineering manager, avoids fluff |
| Entity review | Neutral tone | Frames people in context of your management style |
| Meeting summary | Raw extraction | Highlights what matters to you specifically |

---

## Core Concepts

| Term | Meaning |
|------|---------|
| **Personalization preamble** | Rich text the user writes to describe themselves; stored as HTML (for UI restore) + plain text (for AI injection) |
| **Preamble injection** | Prepending `## About the user\n{text}` to every AI system prompt before any dynamic context |
| **Entity resolution** | `@mention` chips in the preamble are resolved to full entity context (fields + linked notes) and injected alongside the standard entity context block |
| **Note resolution** | `[[note]]` chips in the preamble are resolved and injected as pinned context notes |
| **Personalization tab** | New sub-section inside the AI tab group of `SettingsModal.vue` |

---

## Data Model

### New Settings Keys

No new DB table is needed. Two keys are added to the existing `settings` table:

| Key | Type | Purpose |
|-----|------|---------|
| `ai_personalization_html` | TEXT | Raw `innerHTML` of the `RichTextInput` contenteditable element — used to restore the editor on next open |
| `ai_personalization_text` | TEXT | Plain text extracted from `RichInputContent.text` — injected verbatim into AI prompts |
| `ai_personalization_entity_ids` | TEXT | JSON array of entity UUIDs extracted from `RichInputContent.mentionedEntityIds` — resolved to full entity context at prompt-build time |
| `ai_personalization_note_ids` | TEXT | JSON array of note UUIDs extracted from `RichInputContent.mentionedNoteIds` — resolved and injected as context notes at prompt-build time |

> **Why four keys instead of one JSON blob?** Consistent with the existing `settings` pattern (all values are flat strings). The four keys are logically separate concerns and can evolve independently. The `html` key is renderer-only; the other three are main-process-only.

---

## UI Design — Personalization Tab

### Location

Inside `SettingsModal.vue`, the AI section has a horizontal `tab-bar`. A new entry **Personalization** is added to `aiTabs`, between **AI Features** and **Transcription** (or as the last AI tab — exact position TBD during implementation).

```
AI  [ LLM Providers | AI Features | Personalization | Transcription | Follow-up ]
```

### Tab Content

```
┌─────────────────────────────────────────────────────────────────┐
│  Tell Wizz about yourself                                        │
│  ─────────────────────────────────────────────────────────────  │
│  This is prepended to every AI prompt so Wizz always knows      │
│  who it is talking to. Use @mentions to reference entities       │
│  and [[links]] to include specific notes as context.             │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  I'm a VP of Engineering at Acme Corp, managing          │   │
│  │  @Platform Team (15 engineers) and @Growth Team          │   │
│  │  (8 engineers). My focus this quarter is [[Q2 OKRs]].    │   │
│  │  I prefer concise, bullet-point answers with clear       │   │
│  │  next steps. I lead in English and Polish.               │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                    [Save]        │
└─────────────────────────────────────────────────────────────────┘
```

**Notes on the editor:**
- Uses `RichTextInput.vue` directly — no wrapper component needed
- `max-height` is overridden via CSS variable to allow taller content (e.g. 240px instead of the default 120px chat input height)
- Placeholder text: `"Describe yourself, your role, your team, and your preferences…"`
- Supports `@` entity mentions and `[[` note links — same as chat
- Does **not** support note-selection paste (no `@copy` use case here)
- Auto-save on blur (500ms debounce) + explicit **Save** button
- Shows a "Saved" confirmation inline (no modal)
- No character limit enforced in UI; text is truncated server-side if it would blow the model's context window (see prompt injection)

---

## AI Integration

### Shared Helper: `getPersonalizationPreamble(db)`

New module: `src/main/ai/personalization.ts`

```typescript
export interface PersonalizationContext {
  preamble: string          // plain text for system prompt injection, or '' if not set
  entityIds: string[]       // entity UUIDs to resolve and merge into entity context
  noteIds: string[]         // note UUIDs to resolve and merge into context notes
}

export function getPersonalizationPreamble(db: Database): PersonalizationContext
```

- Reads `ai_personalization_text`, `ai_personalization_entity_ids`, `ai_personalization_note_ids` from `settings`
- Returns empty values if not configured (graceful no-op)
- Truncates `preamble` to 2000 chars if larger (prevents crowding out real context)
- Used by every AI function that builds a system prompt

### Prompt Injection Point

The preamble is injected **immediately after the identity intro** and before any dynamic context blocks. In `chat.ts` (`sendChatMessage`):

```
You are Wizz, an AI assistant…   ← identity (unchanged)

## About the user                 ← NEW — injected by getPersonalizationPreamble()
I'm a VP of Engineering…
I manage @Platform Team…

Today is 2026-03-07.              ← date (unchanged, now below preamble)

Be concise and actionable…        ← instructions (unchanged)

Here are relevant notes…          ← dynamic context (unchanged)
```

The preamble entity/note IDs are merged into the standard context resolution pipeline:
- `entityIds` → fetched and prepended to `richEntities` (same `fetchEntityContext` depth-1 resolution)
- `noteIds` → fetched and prepended to `pinnedNotes` (treated as pinned, highest priority)

### Functions That Receive the Preamble

| Function | File | Inject? | Notes |
|----------|------|---------|-------|
| `sendChatMessage()` | `chat.ts` | ✅ | Primary use case; entity + note resolution too |
| `generateInlineContent()` | `chat.ts` | ✅ | Shorter prompt; preamble sets authoring context |
| `generateDailyBrief()` | `dailyBrief.ts` | ✅ | Personalises prioritisation language |
| `generateEntityReview()` | `reviewGenerator.ts` | ✅ | Personalises relationship framing |
| `generateMeetingSummary()` in `postProcessor.ts` | `postProcessor.ts` | ✅ | Personalises what gets highlighted |
| NER (`ner.ts`) | `ner.ts` | ❌ | Batch entity detection — user context irrelevant |
| Action extraction (`actionExtractor.ts`) | `actionExtractor.ts` | ❌ | Extraction accuracy unaffected by user persona |
| Query expansion (`chat.ts`) | `chat.ts` | ❌ | Short expansion pass, adds noise |
| Re-ranking (`chat.ts`) | `chat.ts` | ❌ | Ranking pass, not generation |

---

## RichTextInput Extension

`RichTextInput.vue` needs one new method exposed via `defineExpose`:

### `setContent(html: string): void`

Restores the editor from saved HTML (innerHTML). Called on mount in the Personalization tab to reload a previously saved preamble.

```typescript
function setContent(html: string): void {
  if (!editorRef.value) return
  editorRef.value.innerHTML = html
  // Rebuild selectionStore from any data-selection-id nodes (none expected for personalization)
  updateEmptyState()
  applyAfterTick(editorRef.value)   // re-apply entity chip colors/icons
}
```

This is a clean addition to the existing public API (`getContent`, `clear`, `focus`, `isEmpty`).

---

## IPC

No new IPC channels are needed. All read/write operations use the existing `settings:get` / `settings:set` channel.

**Read (on tab mount):**
```typescript
const [html, text, entityIds, noteIds] = await Promise.all([
  window.api.invoke('settings:get', { key: 'ai_personalization_html' }),
  window.api.invoke('settings:get', { key: 'ai_personalization_text' }),
  window.api.invoke('settings:get', { key: 'ai_personalization_entity_ids' }),
  window.api.invoke('settings:get', { key: 'ai_personalization_note_ids' }),
])
```

**Write (on save):**
```typescript
const { html, text, mentionedEntityIds, mentionedNoteIds } = richInputRef.value!.getContent()
await Promise.all([
  window.api.invoke('settings:set', { key: 'ai_personalization_html', value: html }),
  window.api.invoke('settings:set', { key: 'ai_personalization_text', value: text }),
  window.api.invoke('settings:set', { key: 'ai_personalization_entity_ids', value: JSON.stringify(mentionedEntityIds) }),
  window.api.invoke('settings:set', { key: 'ai_personalization_note_ids', value: JSON.stringify(mentionedNoteIds) }),
])
```

> Note: `RichInputContent.html` does not exist yet — we use `editorRef.value.innerHTML` exposed via a new method, or we persist it from the parent via a separate call. The implementation plan below addresses this.

---

## Edge Cases & Constraints

| Case | Handling |
|------|---------|
| Empty preamble | `getPersonalizationPreamble()` returns `''`; nothing injected; all prompts unchanged |
| Deleted entity mentioned in preamble | Entity ID in saved JSON no longer found in DB; `fetchEntityContext` returns null; silently skipped |
| Archived note mentioned in preamble | Note excluded from results; silently skipped |
| Preamble > 2000 chars | Truncated with `…` suffix in `getPersonalizationPreamble()`; user warned in tooltip next to Save button |
| Preamble with no entities/notes | Entity/note ID arrays are empty; no extra context added |
| AI provider not configured | No prompt built at all — personalization is a no-op; preamble is saved and will apply once a provider is added |

---

## Implementation Plan

### Phase A — RichTextInput Extension
- [ ] Add `setContent(html: string): void` method to `RichTextInput.vue`
  - Sets `editorRef.value.innerHTML = html`
  - Calls `updateEmptyState()` and `applyAfterTick(editorRef.value)`
- [ ] Add `setContent` to `defineExpose` alongside existing `getContent`, `clear`, `focus`, `isEmpty`
- [ ] Verify that `getContent()` still correctly reads entity/note chip `data-*` attributes after `setContent`

### Phase B — Shared AI Helper
- [ ] Create `src/main/ai/personalization.ts`
  - Export `PersonalizationContext` interface (`preamble: string`, `entityIds: string[]`, `noteIds: string[]`)
  - Implement `getPersonalizationPreamble(db)`: reads three settings keys, parses JSON, truncates text to 2000 chars
  - Returns safe empty defaults if any key is missing/malformed
- [ ] Export `getPersonalizationPreamble` from `src/main/ai/index.ts` (if that barrel exists) or import directly

### Phase C — Prompt Injection in chat.ts
- [ ] In `sendChatMessage()`, call `getPersonalizationPreamble(db)` at the top
- [ ] Inject `preamble` into `systemPrompt` immediately after identity/date strings
- [ ] Merge `entityIds` into the entity context fetch pipeline (prepend to `richEntities` resolution)
- [ ] Merge `noteIds` into `pinnedNotes` (fetched via `notes:get`, inserted before existing pinned notes)
- [ ] In `generateInlineContent()`, call `getPersonalizationPreamble(db)` and prepend to its `systemPrompt`

### Phase D — Prompt Injection in Other AI Functions
- [ ] `generateDailyBrief()` (`src/main/embedding/dailyBrief.ts`): prepend preamble to system prompt
- [ ] `generateEntityReview()` (`src/main/entity/reviewGenerator.ts`): prepend preamble to system prompt
- [ ] `generateMeetingSummary()` / `postProcessor.ts`: prepend preamble to meeting summary system prompt

### Phase E — Settings UI
- [ ] In `SettingsModal.vue`, add `'personalization'` to the `aiTabs` array with label `'Personalization'`
- [ ] Add the Personalization tab panel inside the AI section's `v-if` tab content blocks
- [ ] Panel contains:
  - Section title: "Tell Wizz about yourself"
  - Helper text paragraph (styled like existing helper text in the AI tab)
  - `RichTextInput` component with tall height override (CSS variable `--rich-input-max-height: 240px` or equivalent)
  - Save button + "Saved ✓" confirmation state (300ms show, then fade)
  - Character count indicator when approaching 2000 chars (e.g. show at >1500)
- [ ] On tab mount: load all four settings keys, call `richInputRef.value.setContent(savedHtml)` if `savedHtml` is non-empty
- [ ] On Save click: call `getContent()` on the `RichTextInput` ref, write all four keys via `settings:set`
- [ ] On blur (auto-save fallback): debounced 500ms save, same logic

### Phase F — HTML Persistence Fix
- [ ] Confirm that `RichInputContent` does not include `html` (it doesn't — `getContent()` returns text/ids only)
- [ ] In the Personalization tab, after calling `richInputRef.value.getContent()`, also read `editorRef` innerHTML via a new `getHtml(): string` method on `RichTextInput` (alternative: expose `editorRef` directly — but that breaks encapsulation; prefer `getHtml()`)
- [ ] Add `getHtml(): string` to `RichTextInput.vue` public API: `return editorRef.value?.innerHTML ?? ''`
- [ ] Add `getHtml` to `defineExpose`

### Phase G — Documentation
- [ ] Update `CLAUDE.md`:
  - Add new `settings` keys (`ai_personalization_html/text/entity_ids/note_ids`) to the known keys table
  - Add `PersonalizationContext` / `getPersonalizationPreamble` to AI routing section
  - Add `setContent` and `getHtml` to `RichTextInput.vue` description
  - Add Personalization tab to `SettingsModal.vue` description
- [ ] Update `DESIGN.md`:
  - Add "Phase 9 — AI Personalization" section with this checklist
  - Reference this feature file

---

## Design Decisions Log

| Decision | Rationale |
|----------|-----------|
| Reuse `RichTextInput` instead of a full TipTap editor | Consistency: same rich-text input used in AI chat and inline context; no new editing paradigm |
| Four flat settings keys instead of one JSON blob | Matches existing `settings` pattern; main process reads only `text/entity_ids/note_ids` (no HTML); renderer reads only `html` for restore |
| Inject preamble in every prompt, not just chat | Engineering managers want consistent context everywhere — a daily brief or entity review that doesn't know who the user is feels broken |
| 2000-char truncation | Keeps token budget predictable; most useful preambles are 3-5 sentences; heavy users can express richer context via linked notes/entities |
| Entity resolution via existing `fetchEntityContext` | No new resolution logic; personalization entities get the same depth-1 field expansion as chat `@mentions` |
| Note resolution via `pinnedNotes` | Pinned notes already have the highest context priority in the prompt; personalization notes should be treated the same way |
| No new IPC channel | `settings:get/set` is sufficient; avoids IPC surface growth for a simple key-value store |
| `setContent` + `getHtml` added to RichTextInput public API | Natural extension of existing `getContent/clear/focus/isEmpty`; makes the component a full controlled input suitable for settings panels, not just transient inputs |
