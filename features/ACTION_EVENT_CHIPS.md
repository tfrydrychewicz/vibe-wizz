# Feature: Action & Event Reference Chips in AI Replies

## Overview

When the AI responds in chat, daily briefs, or entity reviews, it references action items and
calendar events with raw IDs — e.g. `"Bartek will talk to Maciej" [id:376feca9-…]` or
`Tue, Mar 10, 2026 4:00 PM — "1-1 Bartosz / Tomek" [id:895]`. These appear as unclickable
plain text with opaque UUIDs/integers that reveal nothing to the reader.

This feature extends the existing chip system (`wizz-entity-chip`, `wizz-note-chip`,
`wizz-web-chip`) with two new canonical chip types so that every AI-generated surface in
the app renders action items and calendar events as interactive, visually distinct inline
chips — identically to how entity mentions and note links already work.

---

## Design Principles

- **Zero new infrastructure.** Reuse the existing `renderInline()` placeholder strategy,
  the `{{type:id:label}}` token convention, and the CSS chip system in `style.css`.
- **Single source of truth.** `renderActionChip` / `renderEventChip` in `markdown.ts`
  are the only places that produce chip HTML. Every surface calls them; none re-implements
  the HTML inline.
- **Graceful degradation.** If an ID cannot be resolved to a title (e.g. a deleted task,
  an event outside the current context), the raw token is left as plain text — content
  is never corrupted.
- **Consistent click behaviour.** Action chips open `TaskDetailPanel`
  (via `taskDetailStore.openDetail`). Event chips navigate to the Calendar view at the
  event's date. Same surface, same mechanism, everywhere.
- **Backend resolution, not renderer lookup.** `renderInline()` is a pure text→HTML
  transformer. Title resolution happens in `chat.ts` (where the data is already in
  memory) before the content reaches the renderer, exactly as `{{entity:uuid:Name}}`
  tokens are already constructed server-side.

---

## Surfaces

| Surface | Before | After |
|---------|--------|-------|
| Chat sidebar (AI reply) | `"Task title" [id:uuid]` — plain text | Orange chip: `☑ Task title` |
| Chat sidebar (AI reply) | `"Event title" [id:895]` — plain text | Indigo chip: `📅 Event title` |
| Daily Brief (`TodayView`) | Same raw ID form | Same chip rendering via `renderInline()` |
| Entity Review (`EntityReviewPanel`) | Same raw ID form | Same chip rendering via `renderInline()` |

---

## Token Convention

The AI is instructed via system prompt to use typed ID references:

```
[task:UUID]     ← action item reference
[event:ID]      ← calendar event reference (numeric ID)
```

These are unambiguous (typed prefix), parseable by a simple regex, and only require
the AI to emit an ID (the backend supplies the human-readable title).

### Why not `[task:UUID "Title"]` (embedding title in AI output)?

Embedding the title burdens the AI with faithfully reproducing a precise string that is
already known server-side. The existing pattern for entities / notes resolves labels
server-side (the AI writes `@EntityName`, the backend resolves the ID; the AI writes
`[task:UUID]`, the backend resolves the title). This keeps the AI output simple and
the resolution logic in one place.

---

## Data Flow

```
1. User sends a message
   → chat:send IPC handler (ipc.ts)
       → buildChatContext(): gathers action items + calendar events with their IDs
         and includes them in the system prompt under
         "## Action items" and "## Upcoming calendar events"
       → sendChatMessage() in chat.ts

2. Claude generates a response, may write:
       "As discussed, @Alice should handle [task:376feca9-dfb0-485e-a685-68826b730247]
        before [event:895]."

3. After tool-use loop in sendChatMessage():
   → resolveActionEventTokens(content, actionItems, calendarEvents)
       a. Scan for /\[task:([0-9a-f-]{36})\]/g
          → look up title in actionItems[] already in scope
          → replace with {{action:UUID:Title}} (or leave as plain text if not found)
       b. Scan for /\[event:(\d+)\]/g
          → look up title + start_at in calendarEvents[] already in scope
          → replace with {{event:ID:Title · HH:MM}} (or leave as plain text if not found)
   → returns transformed content string

4. Content returned to renderer as part of chat:send response

5. ChatSidebar.vue — renderMessage(content) calls renderInline(line)
   → renderInline() Pass 1g: {{action:UUID:Title}} → WIZZACTnWIZZACT placeholder
   → renderInline() Pass 1h: {{event:ID:Label}} → WIZZEVTnWIZZEVT placeholder
   → Pass 3: substitute with renderActionChip(id, title) / renderEventChip(id, label)

6. Click delegation in ChatSidebar:
   → [data-action-id] → taskDetailStore.openDetail(id)
   → [data-event-id]  → emit 'navigate-to-event' { eventId, date }
                         → App.vue: activeView = 'calendar', passes focusEventId

7. Same flow for TodayView and EntityReviewPanel —
   markdownToHtml() already calls renderInline(); only click delegation is added.
```

---

## Architecture Changes

### `src/renderer/utils/markdown.ts`

Add constants:
```ts
export const ACTION_CHIP_CLASS = 'wizz-action-chip'
export const EVENT_CHIP_CLASS  = 'wizz-event-chip'
```

Add chip generators:

```ts
const CHECK_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" …>…</svg>'
const CALENDAR_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" …>…</svg>'

export function renderActionChip(id: string, title: string): string {
  return (
    `<button class="${ACTION_CHIP_CLASS}" data-action-id="${escapeHtml(id)}" ` +
    `data-action-title="${escapeHtml(title)}" title="${escapeHtml(title)}">` +
    `${CHECK_SVG}${escapeHtml(title)}` +
    `</button>`
  )
}

export function renderEventChip(id: string | number, label: string): string {
  return (
    `<button class="${EVENT_CHIP_CLASS}" data-event-id="${escapeHtml(String(id))}" ` +
    `data-event-label="${escapeHtml(label)}" title="${escapeHtml(label)}">` +
    `${CALENDAR_SVG}${escapeHtml(label)}` +
    `</button>`
  )
}
```

Extend `renderInline()` with two new passes **before** HTML escaping:

```ts
// Pass 1g: {{action:UUID:Title}} — resolved by backend
const actionItems: { id: string; title: string }[] = []
const withActionPlaceholders = withBareUrlPlaceholders.replace(
  /\{\{action:([0-9a-f-]{36}):([^}]*)\}\}/gi,
  (_m, id, title) => {
    actionItems.push({ id, title: title.trim() })
    return `WIZZACT${actionItems.length - 1}WIZZACT`
  },
)

// Pass 1h: {{event:ID:Label}} — resolved by backend
const eventItems: { id: string; label: string }[] = []
const withEventPlaceholders = withActionPlaceholders.replace(
  /\{\{event:(\d+):([^}]*)\}\}/g,
  (_m, id, label) => {
    eventItems.push({ id, label: label.trim() })
    return `WIZZEVT${eventItems.length - 1}WIZZEVT`
  },
)
```

Then in Pass 3 substitution:
```ts
result = result.replace(/WIZZACT(\d+)WIZZACT/g, (_m, i) =>
  actionItems[Number(i)] ? renderActionChip(actionItems[Number(i)].id, actionItems[Number(i)].title) : ''
)
result = result.replace(/WIZZEVT(\d+)WIZZEVT/g, (_m, i) =>
  eventItems[Number(i)] ? renderEventChip(eventItems[Number(i)].id, eventItems[Number(i)].label) : ''
)
```

---

### `src/renderer/style.css`

```css
/* ── Action item chip (.wizz-action-chip) ──────────────────────────────────── */
.wizz-action-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #fff7ed;          /* amber-50 */
  color: #c2410c;               /* orange-700 */
  border: 1px solid #fed7aa;   /* orange-200 */
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  margin: 0 1px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.wizz-action-chip:hover { background: #ffedd5; } /* orange-100 */
.wizz-action-chip svg { flex-shrink: 0; }

/* ── Calendar event chip (.wizz-event-chip) ────────────────────────────────── */
.wizz-event-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #eef2ff;          /* indigo-50 */
  color: #4338ca;               /* indigo-700 */
  border: 1px solid #c7d2fe;   /* indigo-200 */
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  margin: 0 1px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.wizz-event-chip:hover { background: #e0e7ff; }  /* indigo-100 */
.wizz-event-chip svg { flex-shrink: 0; }
```

---

### `src/main/embedding/chat.ts`

**System prompt additions** (both `sendChatMessage()` and `generateDailyBrief()` / `generateEntityReview()`):

```
When referring to a specific action item from context, write [task:UUID] using the exact UUID.
When referring to a specific calendar event from context, write [event:ID] using the exact numeric ID.
These tokens will be rendered as interactive chips in the UI — do not include raw IDs any other way.
```

**New helper** `resolveActionEventTokens(content, actionItems, calendarEvents)`:

```ts
function resolveActionEventTokens(
  content: string,
  actionItems: ActionItem[],         // already in scope from the function params
  calendarEvents: CalendarEvent[],   // already in scope
): string {
  // 1. Build lookup maps
  const taskMap = new Map(actionItems.map(a => [a.id, a.title]))
  const eventMap = new Map(calendarEvents.map(e => [String(e.id), { title: e.title, start_at: e.start_at }]))

  // 2. Replace [task:UUID] → {{action:UUID:Title}}
  let out = content.replace(/\[task:([0-9a-f-]{36})\]/gi, (_m, id) => {
    const title = taskMap.get(id)
    return title ? `{{action:${id}:${title}}}` : _m   // leave as-is if not found
  })

  // 3. Replace [event:ID] → {{event:ID:Title · time}}
  out = out.replace(/\[event:(\d+)\]/g, (_m, id) => {
    const ev = eventMap.get(id)
    if (!ev) return _m
    const time = ev.start_at ? new Date(ev.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
    const label = time ? `${ev.title} · ${time}` : ev.title
    return `{{event:${id}:${label}}}`
  })

  return out
}
```

Call `resolveActionEventTokens()` at the end of `sendChatMessage()`, `generateDailyBrief()`,
and `generateEntityReview()` before returning the content string. The action items and
calendar events are already available as parameters or local variables in each of those
functions.

---

### `src/main/db/ipc.ts` — `chat:send` handler

Ensure that the action items injected into Claude's system prompt include their UUIDs in
a machine-readable form Claude can reproduce verbatim:

```
## Action items (open)
- [task:376feca9-dfb0-485e-a685-68826b730247] Bartek will talk to Maciej Arciuch to figure out the plan — assigned: Bartek, due: —
```

This changes only the formatting of the existing action items block in the system prompt,
making the ID explicit so Claude can reference it.

Same for calendar events:
```
## Upcoming calendar events
- [event:895] 1-1 Bartosz / Tomek — Tue Mar 10, 2026 4:00–4:30 PM
```

---

### `src/renderer/components/ChatSidebar.vue`

Extend `onBubbleClick(e)` (the existing `v-html` click delegate):

```ts
// Action chip
const actionChip = (e.target as HTMLElement).closest('[data-action-id]')
if (actionChip) {
  const id = (actionChip as HTMLElement).dataset.actionId!
  taskDetailStore.openDetail(id)
  return
}

// Event chip
const eventChip = (e.target as HTMLElement).closest('[data-event-id]')
if (eventChip) {
  const id = (eventChip as HTMLElement).dataset.eventId!
  emit('navigate-to-event', { eventId: Number(id) })
  return
}
```

Add `navigate-to-event: [{ eventId: number }]` to the emits definition.

---

### `src/renderer/components/TodayView.vue`

Extend the existing click-delegate handler on the brief container:

```ts
const actionChip = (e.target as HTMLElement).closest('[data-action-id]')
if (actionChip) { taskDetailStore.openDetail((actionChip as HTMLElement).dataset.actionId!); return }

const eventChip = (e.target as HTMLElement).closest('[data-event-id]')
if (eventChip) { emit('navigate-to-event', { eventId: Number((eventChip as HTMLElement).dataset.eventId!) }); return }
```

Add `navigate-to-event` to emits; handled in `App.vue`.

---

### `src/renderer/components/EntityReviewPanel.vue`

Same delegation additions as `TodayView`, scoped to the review card container.

---

### `src/App.vue`

Handle the new `navigate-to-event` emit from `ChatSidebar`, `TodayView`, and
`EntityReviewPanel`:

```ts
function onNavigateToEvent({ eventId }: { eventId: number }): void {
  activeView.value = 'calendar'
  nextTick(() => {
    calendarViewRef.value?.focusEvent(eventId)
  })
}
```

### `src/renderer/components/CalendarView.vue`

Expose a `focusEvent(eventId: number)` method via `defineExpose`:
- Set the view to the day/week that contains the event.
- Highlight (briefly animate or scroll to) the event tile.

---

## Backward Compatibility

- `[id:UUID]` and `[id:N]` (the old generic format the AI used before this change) are
  **not** parsed as chips — they render as plain text. This is safe: the system prompt
  change teaches Claude the new format going forward; old stored messages in session remain
  readable.
- `resolveActionEventTokens()` is a no-op if the content contains no `[task:…]` or
  `[event:…]` tokens, so existing call sites are unaffected.

---

## Files Changed

| File | Change |
|------|--------|
| `src/renderer/utils/markdown.ts` | Add `ACTION_CHIP_CLASS`, `EVENT_CHIP_CLASS`, `renderActionChip`, `renderEventChip`; extend `renderInline()` with Pass 1g/1h |
| `src/renderer/style.css` | Add `.wizz-action-chip` and `.wizz-event-chip` CSS |
| `src/main/embedding/chat.ts` | Add `resolveActionEventTokens()`; update system prompts in `sendChatMessage()`, `generateDailyBrief()`, `generateEntityReview()` |
| `src/main/db/ipc.ts` | Reformat action items and calendar events in system prompt to include typed IDs |
| `src/renderer/components/ChatSidebar.vue` | Extend `onBubbleClick()` for `data-action-id` and `data-event-id`; add `navigate-to-event` emit |
| `src/renderer/components/TodayView.vue` | Extend click delegate; add `navigate-to-event` emit |
| `src/renderer/components/EntityReviewPanel.vue` | Extend click delegate; emit `navigate-to-event` |
| `src/App.vue` | Handle `navigate-to-event`; switch to Calendar view; call `calendarViewRef.focusEvent()` |
| `src/renderer/components/CalendarView.vue` | Expose `focusEvent(eventId)` via `defineExpose` |

No DB schema changes. No new IPC channels. No new migration files.

---

## Implementation Checklist

### Phase A — Shared chip infrastructure (`markdown.ts` + `style.css`)
- [x] **A1.** Export `ACTION_CHIP_CLASS = 'wizz-action-chip'` and `EVENT_CHIP_CLASS = 'wizz-event-chip'` from `markdown.ts`
- [x] **A2.** Add inline check-circle SVG constant (`CHECK_CIRCLE_SVG`, 11×11) to `markdown.ts`
- [x] **A3.** Add inline calendar SVG constant (`CALENDAR_CHIP_SVG`, 11×11) to `markdown.ts`
- [x] **A4.** Implement `renderActionChip(id: string, title: string): string` in `markdown.ts`
- [x] **A5.** Implement `renderEventChip(id: string | number, label: string): string` in `markdown.ts`
- [x] **A6.** Add Pass 1g in `renderInline()`: match `{{action:UUID:Title}}` → `WIZZACTnWIZZACT`
- [x] **A7.** Add Pass 1h in `renderInline()`: match `{{event:ID:Label}}` → `WIZZEVTnWIZZEVT`
- [x] **A8.** Add Pass 3 substitution blocks for `WIZZACT` and `WIZZEVT` placeholders
- [x] **A9.** Add `.wizz-action-chip` CSS (orange tint, check-circle icon, `max-width`, ellipsis) to `style.css`
- [x] **A10.** Add `.wizz-event-chip` CSS (indigo tint, calendar icon, `max-width`, ellipsis) to `style.css`
- [x] **A11.** Verify `renderInline()` with no action/event tokens still produces identical output (no regression)

### Phase B — Backend token resolution (`tokenFormat.ts` + `chat.ts` + `dailyBrief.ts` + `reviewGenerator.ts`)
- [x] **B1.** Implement `resolveActionEventTokens(content, actionItems, calendarEvents)` in `src/main/utils/tokenFormat.ts` (shared utility, imported by all AI modules)
  - Regex scan for `[task:UUID]` → lookup in `actionItems` map → replace with `{{action:UUID:Title}}`
  - Regex scan for `[event:ID]` → lookup in `calendarEvents` map → replace with `{{event:ID:Label}}`
  - Leave unmatched tokens as plain text (graceful degradation)
- [x] **B2.** Call `resolveActionEventTokens()` at the end of `sendChatMessage()` before returning
- [x] **B3.** Call `resolveActionEventTokens()` in `generateDailyBrief()` after AI response
- [x] **B4.** Call `resolveActionEventTokens()` in `generateEntityReview()` after AI response
- [x] **B5.** Update `sendChatMessage()` system prompt: add typed-ID reference instruction for tasks and events
- [x] **B6.** Update `generateDailyBrief()` system prompt: same instruction; `fmtAction()` now prefixes `[task:UUID]`; calendar lines prefixed `[event:ID]`
- [x] **B7.** Update `generateEntityReview()` / `buildPrompt()`: same instruction; `fmtAction()` and calendar lines now include typed prefixes
- [x] **B8.** `formatActionItem()` in `chat.ts`: prefix changed from `[id:UUID]` to `[task:UUID]`
- [x] **B9.** `formatCalendarEvent()` in `chat.ts`: prefix changed from `[id:N]` to `[event:N]`; updated system prompt wording

### Phase C — Click delegation (`ChatSidebar.vue`)
- [x] **C1.** Import `fireOpenDetail` from `taskDetailStore` in `ChatSidebar.vue`
- [x] **C2.** In `onBubbleClick(e)`: add `[data-action-id]` branch → `fireOpenDetail(id)`
- [x] **C3.** In `onBubbleClick(e)`: add `[data-event-id]` branch → `emit('navigate-to-event', { eventId })`
- [x] **C4.** Add `'navigate-to-event': [{ eventId: number }]` to `ChatSidebar` emits

### Phase D — Click delegation (`TodayView.vue`)
- [x] **D1.** Import `fireOpenDetail` from `taskDetailStore` in `TodayView.vue`
- [x] **D2.** Extend `onBriefClick()`: `[data-action-id]` → `fireOpenDetail(id)`
- [x] **D3.** Extend `onBriefClick()`: `[data-event-id]` → `emit('navigate-to-event', { eventId })`
- [x] **D4.** Add `'navigate-to-event'` to `TodayView` emits

### Phase E — Click delegation (`EntityReviewPanel.vue`)
- [x] **E1.** Import `fireOpenDetail` from `taskDetailStore` in `EntityReviewPanel.vue`
- [x] **E2.** Extend `onBodyClick()`: `[data-action-id]` → `fireOpenDetail(id)`
- [x] **E3.** Extend `onBodyClick()`: `[data-event-id]` → `emit('navigate-to-event', { eventId })`
- [x] **E4.** Add `'navigate-to-event'` to `EntityReviewPanel` emits; bubbled through `EntityDetail` → `App.vue`

### Phase F — Calendar navigation (`CalendarView.vue` + `App.vue`)
- [x] **F1.** In `CalendarView.vue`: implement `focusEvent(eventId: number)`:
  - Find the event in the currently loaded events array; fetches wider 6-month range if not found
  - Set `currentDate.value` to the event's date (works across all view modes)
  - After `nextTick()`, scroll the time grid to the event's start hour
  - Apply 2-second `event-highlight-pulse` animation on the event tile (`.is-highlighted` class)
- [x] **F2.** Expose `focusEvent` via `defineExpose` in `CalendarView.vue`
- [x] **F3.** Add `calendarViewRef` template ref in `App.vue` pointing at the full-screen `<CalendarView>`
- [x] **F4.** In `App.vue`: `onNavigateToEvent({ eventId })` sets `activeView = 'calendar'`, awaits `nextTick()`, calls `calendarViewRef.value?.focusEvent(eventId)`
- [x] **F5.** Wire `@navigate-to-event="onNavigateToEvent"` on `<ChatSidebar>`, `<TodayView>`, `<EntityDetail>` (bubbled from `EntityReviewPanel`) in `App.vue`

### Phase G — Verification (manual testing)
- [ ] **G1.** Chat: ask "what are my open tasks?" → AI response includes `[task:UUID]` tokens → chips render with orange tint → click opens `TaskDetailPanel`
- [ ] **G2.** Chat: ask "what's on my calendar this week?" → AI response includes `[event:ID]` tokens → chips render with indigo tint → click navigates Calendar view to the event
- [ ] **G3.** Daily Brief: regenerate → any tasks/events referenced appear as chips → clicks work
- [ ] **G4.** Entity Review: generate a review for a Person entity → task/event chips in the review → clicks work
- [ ] **G5.** Unresolvable ID (task deleted between generation and click) → chip still renders (title was embedded at generation time) → `TaskDetailPanel` shows "not found" gracefully
- [ ] **G6.** No action/event tokens in response → `resolveActionEventTokens()` returns input unchanged → no regression in rendering

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| AI writes old `[id:UUID]` format (before system prompt update takes effect) | Not parsed as chip; renders as plain bracketed text — acceptable degradation |
| Action item deleted after brief was generated | Title is already embedded in `{{action:UUID:Title}}`; chip renders fine; `TaskDetailPanel` shows "not found" message |
| Event is in the past / not in calendar view window | `focusEvent()` triggers a re-fetch for the event's date; if event row deleted, no-op |
| `[task:UUID]` in AI response but ID not in `actionItems` context | `resolveActionEventTokens()` leaves token as plain `[task:UUID]` text — not rendered as chip |
| Very long task title (>280px chip) | `max-width: 280px` + `text-overflow: ellipsis` on chip; full title in `title=""` attribute tooltip |
| Same event/task referenced multiple times | Each occurrence independently replaced — correct chip rendered each time |
| `{{action:…}}` token in AI response body containing `}}` in the title | Title truncated at first `}}`; safe because titles are plain text and rarely contain `}}` |
| Daily brief running without any action items in DB | `actionItems = []` → `taskMap` is empty → no tokens to replace → output unchanged |
