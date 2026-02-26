# Recurring Meetings — Design & Implementation Plan

## 1. Motivation

Engineering managers run the same meetings repeatedly — weekly standups, biweekly 1:1s,
monthly retros. Today Wizz treats every calendar event as a one-off. You'd need to
manually recreate the same event each week, and there's no way to navigate from this
week's standup notes to last week's.

**Recurring meetings** solves this by letting a single event definition automatically
populate the calendar for weeks or months ahead, with every occurrence able to carry
its own note. From any note linked to a recurring occurrence the user can browse the
full note history of that series — "What did we cover in the last 5 standups?" — without
a separate search.

---

## 2. Core Concepts

| Term | Meaning |
|------|---------|
| **Series root** | The event row that defines the recurrence rule. Has `recurrence_rule` set, shown on the calendar as the first occurrence. |
| **Occurrence** | A generated event row for one instance of the series. Has `recurrence_series_id` pointing to the series root. |
| **Linked note** | Any occurrence can independently have its own `linked_note_id`, just like a regular event today. |
| **Series note history** | All past-occurrence notes from the same series, accessible from the NoteEditor. |

---

## 3. Data Model Changes

### 3.1 New columns on `calendar_events` — migration `0004`

```sql
ALTER TABLE calendar_events ADD COLUMN recurrence_series_id  TEXT;  -- FK → calendar_events.id (series root)
ALTER TABLE calendar_events ADD COLUMN recurrence_instance_date TEXT; -- ISO date YYYY-MM-DD of this slot
```

| Column | Series root | Generated occurrence | Plain (non-recurring) event |
|--------|------------|---------------------|------------------------------|
| `recurrence_rule` | set (JSON) | NULL | NULL |
| `recurrence_series_id` | NULL | = root.id | NULL |
| `recurrence_instance_date` | NULL | set (YYYY-MM-DD) | NULL |

The series root's own `start_at` date serves as the first occurrence date — no need to
duplicate it into `recurrence_instance_date`.

### 3.2 Recurrence Rule Format

Stored as JSON in `calendar_events.recurrence_rule`:

```json
{
  "freq": "weekly",
  "days": ["tue", "thu"],
  "until": "2026-12-31",
  "count": null
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `freq` | `"daily"` \| `"weekly"` \| `"biweekly"` \| `"monthly"` | required |
| `days` | `["mon","tue","wed","thu","fri","sat","sun"]` | weekly/biweekly only; defaults to day of `start_at` |
| `until` | ISO date string | end date (inclusive); mutually exclusive with `count` |
| `count` | integer | max total occurrences; mutually exclusive with `until` |

Both `until` and `count` optional — if neither is set the series is open-ended (generated
up to a rolling 6-month horizon).

### 3.3 Index

```sql
CREATE INDEX IF NOT EXISTS idx_calendar_events_series ON calendar_events(recurrence_series_id);
```

---

## 4. Occurrence Generation

### 4.1 Generation window

Occurrences are pre-generated for **6 months ahead** from today. This is recalculated:
- On app startup (fill any gaps)
- Whenever a recurring event is created or its rule is changed
- When `CalendarView` navigates beyond the last generated occurrence date

### 4.2 Generation algorithm

```
generateOccurrences(root, fromDate, toDate):
  parse root.recurrence_rule
  dates = expandRRule(root.start_at, rule, fromDate, toDate)
  for date in dates:
    if not exists occurrence with (series_id = root.id AND instance_date = date):
      INSERT calendar_events(
        title            = root.title,
        start_at         = combine(date, timeOf(root.start_at)),
        end_at           = combine(date, timeOf(root.end_at)),
        attendees        = root.attendees,
        recurrence_series_id  = root.id,
        recurrence_instance_date = date
      )
```

Existing occurrences that have a `linked_note_id` are **never overwritten or deleted**
(they have been touched by the user). Occurrences without a linked note and with
`start_at > now` are eligible for regeneration when the rule changes.

### 4.3 Edit scope

When updating a recurring event from `MeetingModal`, the user chooses:

| Scope | What changes | What happens to occurrences |
|-------|-------------|----------------------------|
| **This event only** | Detaches occurrence: clears `recurrence_series_id`, clears `recurrence_instance_date` | No change to other occurrences |
| **This and future events** | Updates root rule with `until = day_before(this.start_at)`; creates a new series root from this occurrence forward | Future occurrences without notes deleted; new occurrences generated |
| **All events** | Updates root title/attendees/time | Regenerates untouched future occurrences; leaves note-linked occurrences as-is |

---

## 5. UI Design

### 5.1 MeetingModal — Recurrence section

Added below the End time field in the creation form (also shown in edit mode):

```
┌─────────────────────────────────────────────────────┐
│ Repeat                                        ↻ on  │
│                                                      │
│  Every  [Weekly ▾]                                   │
│                                                      │
│  On     [Mon] [Tue] [Wed] [Thu] [Fri] [Sat] [Sun]   │
│          (days pre-checked based on event start day) │
│                                                      │
│  Ends   ● Never                                      │
│         ○ On  [date picker]                          │
│         ○ After  [__] occurrences                    │
└─────────────────────────────────────────────────────┘
```

When editing an existing occurrence (part of a series):
- A grey badge "↻ Recurring series" shown below the title
- On clicking **Save**: a compact inline picker appears: "Save changes for…"
  - **This event** / **This and future** / **All events**

### 5.2 CalendarView — Recurring event chip

- All recurring occurrences display a small `↻` repeat icon in the bottom-right of the
  event chip (Day / Work-Week / Week views) or after the title (Month view).
- Tooltip on hover: "Recurring · Weekly on Tuesday"

### 5.3 NoteEditor — "Series History" panel

A new collapsible panel appears in NoteEditor **when the linked calendar event is part
of a recurring series** (i.e., `recurrence_series_id` is set on the linked event).

```
┌─────────────────────────────────────────────────────────────┐
│ ↻ Series History — Platform Standup          ▾ 4 previous  │
├─────────────────────────────────────────────────────────────┤
│ Tue Feb 18, 2026   "Platform Standup - Feb 18"              │
│ Bartek flagged a blocker on the payments service…           │
│                                                             │
│ Tue Feb 11, 2026   "Platform Standup - Feb 11"              │
│ Reviewed Q1 OKR progress. Sarah owns…                       │
│                                                             │
│ Tue Feb 4, 2026    "Platform Standup - Feb 4"               │
│ No blockers. Agreed to move standup 30 min earlier…         │
│                                                             │
│ Tue Jan 28, 2026   "Platform Standup - Jan 28"              │
│ (no notes)                                                  │
└─────────────────────────────────────────────────────────────┘
```

- Shows up to **10 most recent past occurrences**, sorted newest first
- Occurrences without a linked note show "(no notes)"
- Occurrences with notes: title + 1-line excerpt from `body_plain`
- Each is clickable with all three open modes (plain / Shift / Cmd)
- Panel is collapsed by default; state persisted in `localStorage` per series ID

---

## 6. IPC Changes

### Updated handlers

| Channel | Change |
|---------|--------|
| `calendar-events:create` | When payload has `recurrence_rule`, generates occurrences for 6-month window after save |
| `calendar-events:update` | New optional field `update_scope: 'this' \| 'future' \| 'all'` (default `'this'`); routes to `applyRecurrenceUpdate()` |
| `calendar-events:delete` | New optional field `delete_scope: 'this' \| 'future' \| 'all'` (default `'this'`); `'future'` deletes occurrence + all later untouched occurrences; `'all'` deletes series root + all occurrences |

### New handler

```typescript
// calendar-events:get-series-notes
// Input:  { series_id: number }
// Output: SeriesOccurrence[]
interface SeriesOccurrence {
  event_id: number
  event_date: string      // ISO date of occurrence
  note_id: string | null
  note_title: string | null
  excerpt: string | null  // first 120 chars of body_plain
}
```

Returns occurrences ordered by `start_at DESC`, `start_at < now()` (past only).
Up to 20 results.

---

## 7. New Utility: `recurrenceEngine.ts`

`src/main/calendar/recurrenceEngine.ts` — pure TypeScript, no external deps:

```typescript
// Parse a RecurrenceRule JSON object from the recurrence_rule column
parseRecurrenceRule(json: string): RecurrenceRule

// Expand a rule into a list of ISO dates between fromDate and toDate
expandDates(startAt: string, rule: RecurrenceRule, fromDate: string, toDate: string): string[]

// Generate/upsert occurrences in DB for a series root
generateOccurrences(db: Database, rootId: number, windowMonths?: number): void

// Apply an edit with scope
applyRecurrenceUpdate(db: Database, occurrenceId: number, changes: Partial<CalendarEvent>, scope: UpdateScope): void
```

---

## 8. Settings

No new settings keys. The 6-month generation window is a hardcoded constant
(`RECURRENCE_WINDOW_MONTHS = 6`).

---

## 9. Implementation Checklist

### Phase A — Data layer

- [x] Create migration `0004_recurring_meetings.ts`:
  - `ALTER TABLE calendar_events ADD COLUMN recurrence_series_id TEXT`
  - `ALTER TABLE calendar_events ADD COLUMN recurrence_instance_date TEXT`
  - `CREATE INDEX idx_calendar_events_series ON calendar_events(recurrence_series_id)`
- [x] Register migration in `src/main/db/migrations/index.ts`
- [x] Create `src/main/calendar/recurrenceEngine.ts`:
  - `parseRecurrenceRule(json)`
  - `expandDates(startAt, rule, fromDate, toDate)` — handles daily / weekly / biweekly / monthly; respects `until` and `count`
  - `generateOccurrences(db, rootId, windowMonths)` — idempotent upsert; never overwrites note-linked occurrences
  - `applyRecurrenceUpdate(db, occurrenceId, changes, scope)` — handles `'this' | 'future' | 'all'`
  - `applyRecurrenceDelete(db, occurrenceId, scope)`

### Phase B — IPC handlers

- [x] Update `calendar-events:create` in `src/main/db/ipc.ts`:
  - After inserting, if `recurrence_rule` is set call `generateOccurrences(db, newId)`
- [x] Update `calendar-events:update`:
  - Accept optional `update_scope` param (default `'this'`)
  - Route to `applyRecurrenceUpdate()` when scope is `'future'` or `'all'`
  - Regenerate occurrences when `recurrence_rule` changes
- [x] Update `calendar-events:delete`:
  - Accept optional `delete_scope` param (default `'this'`)
  - Route to `applyRecurrenceDelete()`
- [x] Add `calendar-events:get-series-notes` handler

### Phase C — MeetingModal UI

- [x] Add `RecurrenceRule` type to `MeetingModal.vue` (or shared types file)
- [x] Add **Repeat toggle + recurrence section** to `MeetingModal.vue`:
  - Toggle on/off
  - Frequency picker: Daily / Weekly / Biweekly / Monthly
  - Day-of-week checkboxes (shown for Weekly/Biweekly; default = day of start_at)
  - End mode: Never / On date / After N occurrences
- [x] Add **"↻ Recurring series" badge** in edit mode for occurrences
- [ ] Add **edit-scope picker** inline (shown after clicking Save on an occurrence):
  - "This event" / "This and future" / "All events"
- [x] Update `calendar-events:update` call to pass `update_scope`
- [x] Update `calendar-events:delete` call to ask scope before deleting recurring occurrences (a two-step dialog: "Delete just this event, all future events, or the entire series?")

### Phase D — CalendarView UI

- [x] Detect recurring occurrences (`recurrence_series_id != null`) in the events list
- [x] Render `↻` repeat indicator on event chips in time-grid view
- [x] Render repeat indicator after title in month-view chips
- [x] Add tooltip showing recurrence description (resolved from root's `recurrence_rule`)

### Phase E — NoteEditor "Series History" panel

- [ ] In `NoteEditor.vue`, after loading `linkedCalendarEvent`, check if it has `recurrence_series_id` set
- [ ] If yes, call `calendar-events:get-series-notes` with the `series_id`
- [ ] Add **"Series History"** collapsible panel below the meeting context header (above the editor body, alongside the existing Transcriptions panel):
  - Header: `↻ Series History — {eventTitle}` + chevron + `{N} previous` count
  - Collapsed by default; toggle state stored in `localStorage` keyed by `series_id`
  - Each row: `{date}` · `{note_title}` · `{excerpt}` or `(no notes)`
  - All rows clickable with all three open modes (plain / Shift / Cmd)
- [ ] Wire `onOpenSeriesNote(e, noteId, noteTitle)` click handler with 3-mode support per navigation rule

### Phase F — Startup generation

- [ ] In `src/main/db/index.ts` (or a new `src/main/calendar/startupTasks.ts`), after `initDatabase()`:
  - Query all series roots (`recurrence_rule IS NOT NULL AND recurrence_series_id IS NULL`)
  - For each root, call `generateOccurrences(db, root.id)` to fill the 6-month window

---

## 10. Non-Goals (out of scope for this phase)

- Google Calendar / Outlook sync of recurrence rules (iCal RRULE import) — future phase
- Exception dates (EXDATE in iCal) — skip for now; deletions cover this use case
- Custom recurrence intervals (e.g., "every 3 weeks") — extend `freq` later if needed
- Moving a single occurrence to a different day ("this event only, new date") — out of scope; detach-and-recreate workflow is sufficient
