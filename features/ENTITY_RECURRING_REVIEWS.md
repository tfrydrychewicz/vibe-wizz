# Entity Recurring Reviews — Automated, Scheduled Summaries per Entity

## Overview

For any entity type (e.g. Person, Project, Team, Decision), users can opt into **automated recurring reviews**: AI-generated summaries of everything Wizz knows about each entity of that type — their mentions in notes, linked action items, upcoming/past calendar events, and entity fields. Reviews are generated on a configurable schedule and are accessible directly from each entity's detail view.

This is the entity-level analogue of the **Daily Brief** feature: where the Daily Brief summarises the user's day, an Entity Review summarises a single entity over a rolling time window (e.g. "What happened with this person/project over the last week?").

---

## Motivating Use Cases

| Entity Type | Use case |
|-------------|----------|
| **Person (1:1 report)** | Weekly auto-summary of everything discussed, promised, and assigned involving this person |
| **Project** | Bi-weekly summary: open tasks, recent decisions, meeting notes, blockers |
| **Team** | Monthly roll-up of team-wide activity, decisions, and upcoming milestones |
| **OKR / Decision** | Quarterly review of progress, related notes, and linked action items |

---

## Core Concepts

| Term | Meaning |
|------|---------|
| **Review** | A single AI-generated markdown document scoped to one entity + one time period |
| **Review schedule** | Per-entity-type config: frequency, day-of-week, and time-of-day |
| **Review window** | The rolling lookback period covered by the review (e.g. last 7 days for weekly) |
| **Review panel** | Collapsible UI section inside `EntityDetail.vue` listing past reviews, newest first |
| **Entity context** | Everything Wizz aggregates to generate the review: fields, notes, action items, calendar events |

---

## Data Model

### New Columns on `entity_types` — Migration `0010`

```sql
ALTER TABLE entity_types ADD COLUMN review_enabled    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE entity_types ADD COLUMN review_frequency  TEXT;   -- 'daily'|'weekly'|'biweekly'|'monthly'
ALTER TABLE entity_types ADD COLUMN review_day        TEXT;   -- 'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun' (weekly/biweekly)
ALTER TABLE entity_types ADD COLUMN review_time       TEXT NOT NULL DEFAULT '07:00'; -- HH:MM local time
```

| Column | Series root | Notes |
|--------|------------|-------|
| `review_enabled` | 0 (off) | Master switch; when 0, no reviews generated for this type |
| `review_frequency` | NULL | Required when `review_enabled = 1` |
| `review_day` | NULL | Required for `weekly` and `biweekly`; ignored for `daily`/`monthly` |
| `review_time` | `'07:00'` | Local time of day for the scheduler window; reviews generated within 1h window |

### New Table: `entity_reviews` — Migration `0010`

```sql
CREATE TABLE IF NOT EXISTS entity_reviews (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  period_start    TEXT NOT NULL,   -- ISO date YYYY-MM-DD: start of covered window
  period_end      TEXT NOT NULL,   -- ISO date YYYY-MM-DD: end of covered window (inclusive)
  content         TEXT NOT NULL,   -- Markdown review body
  generated_at    TEXT NOT NULL,   -- ISO 8601 timestamp
  model_id        TEXT,            -- model used (for reference/debugging)
  acknowledged_at TEXT             -- set when user first expands/views this review
);

CREATE INDEX IF NOT EXISTS idx_entity_reviews_entity ON entity_reviews(entity_id, generated_at DESC);
```

### Period Window by Frequency

| Frequency | `period_start` | `period_end` |
|-----------|---------------|-------------|
| `daily` | yesterday | yesterday |
| `weekly` | 7 days ago | yesterday |
| `biweekly` | 14 days ago | yesterday |
| `monthly` | 30 days ago | yesterday |

---

## AI: Review Generation (`entity-reviews:generate`)

### New Feature Slot: `entity_review`

Added to `src/main/ai/featureSlots.ts`:

```typescript
{
  id: 'entity_review',
  label: 'Entity review summary',
  capability: 'chat',
  description: 'Generates a periodic review of everything Wizz knows about a single entity'
}
```

Default chain: Claude Haiku (fast, lower cost — runs in batch for many entities).

### Context Gathered per Entity

The generator (`src/main/entity/reviewGenerator.ts`) assembles:

1. **Entity type** — the type name (e.g. `Person`, `Project`, `Team`, `Decision`) and its field schema; passed explicitly so the model can tailor the review angle (e.g. a Person review focuses on relationship/collaboration, a Project review focuses on progress/blockers)
2. **Entity fields** — all key-value pairs from the entity's `fields` JSON, resolved through the entity type's field schema with human-readable labels (not raw JSON keys)
3. **Notes (by mention)** — up to 20 most-recent notes that mention the entity (either `manual` or `auto_detected` in `entity_mentions`) within the period window; for each note: title, `updated_at`, first 600 chars of `body_plain`
4. **Action items** — all non-cancelled action items where `assigned_entity_id = entity.id` OR `waiting_for_entity_id = entity.id`; grouped by status; include title, due date, status, project name
5. **Calendar events** — events within the period window where the entity appears as an attendee (matched via `entities:find-by-email` logic but queried in reverse: entity's email field → attendee JSON); include title, start time, linked note title if any
6. **Today's date** and **period window** (so the AI can phrase things correctly)

### Prompt Structure

```
You are a personal knowledge assistant. Generate a concise review for the entity described below.
Cover the period from {period_start} to {period_end}.

The entity type is "{type_name}". Use this to shape the tone and focus of the review:
- Person → focus on relationship, collaboration, commitments made and received, follow-ups
- Project → focus on progress, blockers, decisions, open tasks, milestones
- Team → focus on team-wide activity, decisions, workload distribution, upcoming deadlines
- Decision → focus on rationale recorded, implications discussed, action items triggered
- (any other type) → summarise activity relevant to that kind of entity

## Entity: {name} (type: {type_name})
{fields as labelled key-value pairs, e.g. "Role: Engineering Manager"}

## Recent Notes ({N} notes mentioning this entity in this period)
{for each note: "### {title} ({date})\n{excerpt}\n"}

## Action Items
Open: {list with title, due date, project}
Completed this period: {list}
Waiting for this entity: {list}

## Calendar Events
{list with date, title, linked note title if any}

---

Write a structured Markdown review with the following sections (omit any section with no content):
- **Summary** — 2-3 sentence executive summary tailored to the entity type
- **Key discussions** — bullet points from notes; quote specific decisions or outcomes
- **Open tasks** — action items still open; call out overdue items
- **Completed** — tasks completed in this period
- **Upcoming** — scheduled events or deadlines in the near future
- **Follow-ups** — items that may need attention

Keep the tone factual and professional. Do not hallucinate details not present in the provided context.
```

### Graceful Degradation

- If `entity_review` slot has no configured model → skip generation, log warning, return `{ error: 'No model configured for entity_review feature slot' }`
- If entity has no notes/actions/events in the period → still generate a brief review noting "no activity recorded in this period"

---

## Scheduler

### `src/main/entity/reviewScheduler.ts`

Called at startup alongside `scheduleNightlyClusterBatch()` in `src/main/index.ts`.

```typescript
scheduleEntityReviews(db: Database): void
```

**Logic (runs every 30 minutes):**

1. Load all entity types where `review_enabled = 1`
2. For each type, determine if a review is due now:
   - Get the **expected generation timestamp** for today based on `review_frequency`, `review_day`, `review_time`
   - Check if a review already exists for the correct period window (`period_end = yesterday` for daily/weekly/biweekly/monthly)
   - If no review exists for this window AND current local time ≥ `review_time` → mark as due
3. Load all non-trashed entities of that type
4. For each entity, call `generateEntityReview(db, entity, type)` in sequence (not concurrent — rate limit friendly)
5. Store result in `entity_reviews`
6. Push `entity-review:complete` to renderer with `{ entityId, reviewId }`

**Concurrency guard**: uses a module-level `Set<entityTypeId>` to prevent overlapping runs per type.

---

## IPC Channels

### New Channels

| Channel | Payload | Returns | Notes |
|---------|---------|---------|-------|
| `entity-reviews:list` | `{ entity_id: string }` | `EntityReview[]` sorted newest first | Returns all reviews for this entity |
| `entity-reviews:generate` | `{ entity_id: string }` | `EntityReview \| { error: string }` | Manual on-demand generation; does NOT check schedule; always generates for current window |
| `entity-reviews:acknowledge` | `{ id: string }` | `{ ok: boolean }` | Sets `acknowledged_at`; idempotent |
| `entity-reviews:delete` | `{ id: string }` | `{ ok: boolean }` | Hard-deletes a single review |

### Push Events

| Event | Payload | Fired by |
|-------|---------|---------|
| `entity-review:complete` | `{ entityId: string, reviewId: string }` | Scheduler / manual generate |

### Extended Channels

| Channel | Change |
|---------|--------|
| `entity-types:list` | Returns new columns: `review_enabled`, `review_frequency`, `review_day`, `review_time` |
| `entity-types:create` | Accepts new columns |
| `entity-types:update` | Accepts new columns |

### `EntityReview` TypeScript Type

```typescript
interface EntityReview {
  id: string
  entity_id: string
  period_start: string       // YYYY-MM-DD
  period_end: string         // YYYY-MM-DD
  content: string            // Markdown
  generated_at: string       // ISO 8601
  model_id: string | null
  acknowledged_at: string | null
}
```

---

## UI Design

### EntityTypeModal — New "Reviews" Section

Added as a collapsible section at the bottom of the entity type creation/edit modal, below the field builder:

```
┌──────────────────────────────────────────────────────────────┐
│  Automated Reviews                              ○ ──●  On    │
│  ──────────────────────────────────────────────────────────  │
│                                                              │
│  Frequency     [Weekly ▾]                                    │
│  Day           [Tuesday ▾]   (shown for Weekly / Biweekly)  │
│  Time          [07:00]       local time to generate          │
│                                                              │
│  Reviews will be generated weekly every Tuesday morning      │
│  for each entity of this type.                               │
│                                                              │
│  AI model used from Settings → AI Features → Entity Review   │
└──────────────────────────────────────────────────────────────┘
```

**Controls:**
- Toggle switch (same style as `elevenlabs_diarize` toggle in SettingsModal)
- Frequency select: `Daily | Weekly | Biweekly | Monthly`
- Day-of-week select: `Mon | Tue | Wed | Thu | Fri | Sat | Sun` — visible only for `Weekly` and `Biweekly`
- Time input: `<input type="time">` — HH:MM picker, defaults to `07:00`
- Descriptive sentence below controls summarising the schedule in plain English

**Validation:**
- If `review_enabled = true`, `review_frequency` is required (save button disabled otherwise)
- If frequency is `weekly` or `biweekly`, `review_day` is required

### EntityDetail — "Reviews" Panel

A collapsible panel shown at the bottom of the entity detail view, **below the entity fields** and **above the backlinks/mentions section** (if any). Uses the same visual language as the `SeriesHistory` panel in `NoteEditor`.

```
┌──────────────────────────────────────────────────────────────┐
│ 📋 Reviews                    [Generate now]    ▾ 3 reviews  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Mar 4, 2026 — Mar 10, 2026               Generated Mar 11  │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ **Summary**                                          │    │
│  │ John had a productive week with 3 meetings and 2     │    │
│  │ completed action items. A key decision was made...   │    │
│  │                                                      │    │
│  │ **Open tasks** (2)                                   │    │
│  │ • Review Sasha's design doc — due Mar 15             │    │
│  │ • Follow up on budget proposal                       │    │
│  │ [▾ Read full review]                                 │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  Feb 25, 2026 — Mar 3, 2026               Generated Mar 4   │
│  [▾ Read full review]                                        │
│                                                              │
│  Feb 18, 2026 — Feb 24, 2026              Generated Feb 25  │
│  [▾ Read full review]                                        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Panel behaviour:**
- Panel header shows review count badge; collapsed by default if no unacknowledged reviews; **expanded by default if there are unacknowledged reviews** (same as Daily Brief auto-expansion pattern)
- "Generate now" button triggers `entity-reviews:generate` with loading spinner; always generates for the current window (regardless of schedule)
- Each review row shows: date range, generation timestamp, and the first ~200 chars of content rendered as markdown
- Full content toggle: clicking "Read full review" expands the full markdown body (rendered via the same `markdownToHtml()` utility used in `TodayView`)
- On expand, `entity-reviews:acknowledge` is called (idempotent)
- Per-review delete button (×) with single-click confirmation
- Subscribes to `entity-review:complete` push event → refreshes list in-place

**Unacknowledged indicator:**
- A small blue dot (●) on the panel header when any review has `acknowledged_at = null`, matching the notification dot pattern used elsewhere
- The dot clears as the user expands each review

**When entity type has `review_enabled = false`:**
- Panel is hidden entirely (no empty state clutter)

---

## New Reusable Component: `EntityReviewPanel.vue`

Extracted as its own component (not inlined into `EntityDetail`) for potential future reuse (e.g. in a dedicated "Reviews" sidebar or a `TodayView` widget).

```typescript
// Props
interface Props {
  entityId: string
  reviewEnabled: boolean  // from entity type config — controls visibility
}

// Emits
// (none — panel is self-contained)
```

Internally:
- `onMounted`: calls `entity-reviews:list`
- Subscribes to `entity-review:complete` push: if `entityId` matches → re-fetches list
- Renders a `markdownToHtml()` view for each expanded review
- "Generate now" → calls `entity-reviews:generate` → adds result to list top

---

## New AI Feature Slot in Settings

The `entity_review` slot is surfaced in Settings → AI → AI Features alongside all other slots:

```
Entity Review Summary     Generate periodic summaries for entities
[Claude Haiku ▾] [→] [+ fallback]
```

---

## Consistency & Reuse Notes

- **Toggle switch** for `review_enabled` reuses the same `<button role="switch">` toggle pattern used for `elevenlabs_diarize` in SettingsModal
- **Frequency + day-of-week picker** reuses the visual style of the recurrence picker in `MeetingModal` (same `<select>` style, same day-of-week mental model)
- **Markdown rendering** in the review body uses the same `markdownToHtml()` function from `TodayView.vue` — no new renderer
- **Panel collapse/expand** uses the same `localStorage`-keyed toggle pattern as `SeriesHistory` in `NoteEditor` and the `Transcriptions` panel
- **Unacknowledged dot** uses the same visual as any other notification badge in the sidebar
- **"Generate now" button** follows the same pattern as "Generate Daily Brief" in `TodayView`: triggers IPC, shows spinner, replaces content on success
- **`entity-review:complete` push event** follows the exact push pattern of `transcription:complete`, `calendar-sync:complete`, `action:updated`, etc.
- **Scheduler** reuses the mutex-via-Set pattern from `src/main/calendar/sync/scheduler.ts` and `src/main/embedding/scheduler.ts`
- **`markdownToHtml()`** should be extracted to a shared utility file (`src/renderer/utils/markdown.ts`) since it is now used in both `TodayView` and `EntityReviewPanel` — see Phase A

---

## File Map

| New/changed file | Purpose |
|-----------------|---------|
| `src/main/db/migrations/0010_entity_reviews.ts` | Migration: new columns on `entity_types`, new `entity_reviews` table + index |
| `src/main/entity/reviewGenerator.ts` | Context assembly + AI call per entity |
| `src/main/entity/reviewScheduler.ts` | Nightly/periodic scheduler; due-date logic |
| `src/main/ai/featureSlots.ts` | Add `entity_review` slot |
| `src/main/db/ipc.ts` | New `entity-reviews:*` handlers; extend `entity-types:*` handlers |
| `src/renderer/components/EntityTypeModal.vue` | Add "Automated Reviews" section |
| `src/renderer/components/EntityDetail.vue` | Mount `EntityReviewPanel` |
| `src/renderer/components/EntityReviewPanel.vue` | New self-contained review list component |
| `src/renderer/utils/markdown.ts` | Extract `markdownToHtml()` from `TodayView.vue` (shared utility) |
| `src/renderer/components/TodayView.vue` | Refactor to import `markdownToHtml` from shared util |
| `src/main/index.ts` | Call `scheduleEntityReviews(db)` at startup |

---

## Implementation Checklist

### Phase A — Shared Utility Extraction

- [x] Create `src/renderer/utils/markdown.ts`: extract `markdownToHtml()` from `TodayView.vue`; export it
- [x] Update `TodayView.vue` to import `markdownToHtml` from `@/utils/markdown`
- [x] Verify no visual regression in `TodayView` (same HTML output)

### Phase B — Data Layer

- [x] **Migration `0010`**: create `src/main/db/migrations/0010_entity_reviews.ts`
  - `ALTER TABLE entity_types ADD COLUMN review_enabled INTEGER NOT NULL DEFAULT 0`
  - `ALTER TABLE entity_types ADD COLUMN review_frequency TEXT`
  - `ALTER TABLE entity_types ADD COLUMN review_day TEXT`
  - `ALTER TABLE entity_types ADD COLUMN review_time TEXT NOT NULL DEFAULT '07:00'`
  - `CREATE TABLE IF NOT EXISTS entity_reviews (...)` with all columns
  - `CREATE INDEX idx_entity_reviews_entity ON entity_reviews(entity_id, generated_at DESC)`
- [x] Register `0010` in `src/main/db/migrations/index.ts` → `ALL_MIGRATIONS`
- [x] Update `schema.ts` fresh-install definition: add new `entity_types` columns and `entity_reviews` table

### Phase C — AI Slot & Generator

- [x] **`featureSlots.ts`**: add `entity_review` slot (Chat capability, default Haiku); add to `DEFAULT_CHAINS`
- [x] **`src/main/entity/reviewGenerator.ts`** — new file:
  - `buildEntityContext(db, entity, type, periodStart, periodEnd)` — queries notes, action items, calendar events; returns structured context object including `type.name` and resolved field labels
  - `generateEntityReview(db, entity, type)` — determines period window from `review_frequency`; injects `type.name` prominently in the system prompt so the model tailors its review angle (Person vs Project vs Team etc.); calls `callWithFallback('entity_review', db, fn)`; upserts into `entity_reviews`; returns `EntityReview`
  - Graceful fallback: returns `{ error }` string when slot has no model

### Phase D — Scheduler

- [x] **`src/main/entity/reviewScheduler.ts`** — new file:
  - `scheduleEntityReviews(db)` — exported entry point; sets up `setInterval` (every 30 minutes)
  - `checkAndGenerateReviews(db)` — inner fn: loads enabled entity types; determines due entities; iterates entities serially; calls `generateEntityReview()`; pushes `entity-review:complete`
  - `isReviewDue(type, existingReviews)` — pure function; checks frequency + review_day + review_time against current local time and most recent review's `period_end`
  - Mutex guard via `const runningTypes = new Set<string>()`
- [x] **`src/main/index.ts`**: call `scheduleEntityReviews(db)` after `startCalendarSyncScheduler()`

### Phase E — IPC Handlers

- [x] **`entity-types:list`**: extend SELECT to include `review_enabled`, `review_frequency`, `review_day`, `review_time`
- [x] **`entity-types:create`**: accept and persist review fields
- [x] **`entity-types:update`**: accept and persist review fields
- [x] **`entity-reviews:list`** handler: `SELECT * FROM entity_reviews WHERE entity_id = ? ORDER BY generated_at DESC`
- [x] **`entity-reviews:generate`** handler: validate entity exists; call `generateEntityReview()`; push `entity-review:complete`; return review row or `{ error }`
- [x] **`entity-reviews:acknowledge`** handler: `UPDATE entity_reviews SET acknowledged_at = datetime('now') WHERE id = ? AND acknowledged_at IS NULL`
- [x] **`entity-reviews:delete`** handler: `DELETE FROM entity_reviews WHERE id = ?`
- [x] Register all new handlers in `src/main/db/ipc.ts`

### Phase F — EntityTypeModal UI

- [x] **`EntityTypeModal.vue`**: add "Automated Reviews" section below the fields builder
  - Toggle switch (`review_enabled`) — same `<button role="switch">` pattern as diarize toggle
  - Frequency `<select>`: `Daily | Weekly | Biweekly | Monthly` — shown when enabled
  - Day-of-week `<select>`: `Mon | Tue | Wed | Thu | Fri | Sat | Sun` — shown when frequency is `weekly` or `biweekly`
  - Time `<input type="time">` — shown when enabled; defaults to `07:00`
  - Plain-English description sentence (e.g. "Reviews will be generated every Tuesday at 7:00 AM")
  - Validation: `review_frequency` required when enabled; `review_day` required for weekly/biweekly
- [x] Extend `createType` / `updateType` IPC calls to include review fields
- [x] On load (edit mode): populate controls from fetched entity type data

### Phase G — EntityReviewPanel Component

- [x] **`src/renderer/components/EntityReviewPanel.vue`** — new component:
  - Props: `entityId: string`, `reviewEnabled: boolean`
  - Loads reviews via `entity-reviews:list` on mount and on `entity-review:complete` push (filtered by `entityId`)
  - Panel header: "Reviews" label + unacknowledged count dot + collapsed/expanded chevron + "Generate now" button
  - Collapsed by default unless unacknowledged reviews exist; toggle state in `localStorage` key `entity-reviews-panel-{entityId}`
  - Each review row: period date range + generated_at + first ~200 chars preview + "Read full review" expand toggle
  - Expanded review: full `markdownToHtml()` rendered body
  - On expand: calls `entity-reviews:acknowledge(id)` (clears blue dot)
  - Per-review delete button: single-click confirmation popover (same pattern as inline delete in `TemplateList`)
  - Loading/generating spinner state during `entity-reviews:generate`
  - Empty state (no reviews yet): "No reviews generated yet. Click 'Generate now' to create the first one." — only shown when `reviewEnabled = true`
  - Hidden entirely when `reviewEnabled = false`

### Phase H — EntityDetail Integration

- [x] **`EntityDetail.vue`**: import and mount `<EntityReviewPanel>` below the fields form
  - Pass `entityId` and `reviewEnabled` (derived from entity type config — needs to be loaded; `entity-types:list` is already called in `App.vue`, so pass `typeId` to `EntityDetail` and look up from loaded types, or call `entity-types:get` if a single-type fetch IPC exists — add one if not)
  - Panel loads its own data; `EntityDetail` only provides props

### Phase I — Settings AI Features

- [x] **`SettingsModal.vue`** / **`FeatureChainEditor.vue`**: the new `entity_review` slot will appear automatically in the AI Features tab since it is registered in `FEATURE_SLOTS` — verify it renders correctly with correct label and description
- [x] Verify default chain (Haiku) is seeded by migration `0007`-style logic or by `DEFAULT_CHAINS` fallback

### Phase J — CLAUDE.md & DESIGN.md Updates

- [x] Update `CLAUDE.md`:
  - New IPC channels in the IPC section
  - New push event `entity-review:complete`
  - New feature slot `entity_review`
  - New settings columns on `entity_types`
  - New components: `EntityReviewPanel`
  - New files: `reviewGenerator.ts`, `reviewScheduler.ts`
  - Migration `0010`
- [x] Update `DESIGN.md` phase checklist with this feature's phases

---

## Non-Goals (Out of Scope for This Phase)

- Sending reviews via email or push notification — future phase
- Comparing two review periods ("what changed between last week and this week?") — future phase
- Exporting reviews to PDF/Markdown file — future phase
- Per-entity opt-out (individual entity override of the type-level setting) — possible future setting on entity itself
- Showing reviews in the Daily Brief — could be a later integration (e.g. "2 entity reviews were generated since your last brief")
- Custom prompt templates per entity type — extend `review_prompt` column in a future migration if needed
