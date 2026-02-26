# Calendar Sync — Design & Implementation Plan

## 1. Motivation

Engineering managers live in Google Calendar. Wizz already lets you manually create events,
but they're siloed from real calendars — no attendees, no recurring 1:1s, no upcoming meetings
fetched automatically. This feature pulls external calendar data into Wizz so the AI context
(Daily Brief, transcription detection, chat) reflects what's actually on the user's schedule.

**Phase 1** is read-only: events flow *in* from external calendars. Future phases add CRUD write-back.

---

## 2. Design Principles

1. **Provider-agnostic abstraction.** A `CalendarProvider` interface decouples the sync engine
   from any specific integration method. Adding Outlook, iCal, or direct OAuth later is adding
   a new provider file — nothing else changes.

2. **Multiple calendars, multiple sources.** A user might sync their work Google Calendar via
   Apps Script AND a public team iCal URL. Each source is a separately configured, independently
   scheduled unit stored in `calendar_sources`.

3. **No new infrastructure.** The first provider (Google Apps Script) requires no OAuth app
   registration, no cloud backend, no API key — only a URL that the user generates themselves.

4. **Read-only first.** Synced events are marked with their source; local edits (linking notes,
   attendee mapping) are preserved across re-syncs. Destructive write-back is a future phase.

5. **Configurable refresh cadence.** Each source has its own sync interval (15 min → 24 h).
   A background scheduler fires periodically; per-source mutex prevents overlapping runs.

---

## 3. Integration Methods Overview

| Method | Auth | Write support | Complexity | Status |
|--------|------|---------------|------------|--------|
| **Google Apps Script** | None (user deploys Web App) | Future | Low | ✅ Phase 1 |
| **iCal URL** | None (public or secret URL) | Never (read-only spec) | Very low | Planned |
| **Google Calendar API** | OAuth 2.0 + GCP app | Full CRUD | High | Planned |
| **Microsoft Outlook / Graph API** | OAuth 2.0 + Azure app | Full CRUD | High | Planned |

---

## 4. Provider Abstraction

### 4.1 `CalendarProvider` Interface

```typescript
// src/main/calendar/sync/provider.ts

export interface ExternalEvent {
  externalId:      string   // Provider-unique event ID
  calendarId:      string   // Which calendar within the provider
  title:           string
  startAt:         string   // ISO 8601
  endAt:           string   // ISO 8601
  isAllDay:        boolean
  attendees:       { name?: string; email: string }[]
  recurrenceRule?: string   // RFC 5545 RRULE or null
  description?:    string
}

export interface VerifyResult {
  ok:           boolean
  error?:       string
  displayName?: string                           // e.g. "alice@gmail.com"
  calendars?:   { id: string; name: string }[]  // discovered calendars
}

export interface CalendarProvider {
  readonly id:   string   // 'google_apps_script' | 'ical' | 'google_api' | 'outlook'
  readonly name: string   // Display name

  /** Test connectivity and return discovered calendars. No side-effects. */
  verify(config: Record<string, string>): Promise<VerifyResult>

  /** Fetch all events in [from, to]. May return recurring occurrences expanded or as rules. */
  fetchEvents(
    config: Record<string, string>,
    from:   Date,
    to:     Date
  ): Promise<ExternalEvent[]>
}
```

### 4.2 Provider Registry

```typescript
// src/main/calendar/sync/registry.ts
import { googleAppsScriptProvider } from './providers/googleAppsScript'
// import { icalProvider }            from './providers/ical'      // future
// import { googleApiProvider }       from './providers/googleApi' // future
// import { outlookProvider }         from './providers/outlook'   // future

export const PROVIDERS: Record<string, CalendarProvider> = {
  google_apps_script: googleAppsScriptProvider,
}

export function getProvider(id: string): CalendarProvider | undefined {
  return PROVIDERS[id]
}
```

---

## 5. Data Model

### 5.1 New Table — `calendar_sources`

Added to `src/main/db/schema.ts` (fresh installs) AND migration `0005` (existing installs):

```sql
CREATE TABLE IF NOT EXISTS calendar_sources (
  id                    TEXT PRIMARY KEY,           -- ULID
  provider_id           TEXT NOT NULL,              -- 'google_apps_script' | 'ical' | ...
  name                  TEXT NOT NULL,              -- User-given label
  config                TEXT NOT NULL DEFAULT '{}', -- JSON: provider-specific fields
  enabled               INTEGER NOT NULL DEFAULT 1,
  sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
  last_sync_at          TEXT,                       -- ISO 8601 of last successful sync
  created_at            TEXT NOT NULL
);
```

### 5.2 New Column on `calendar_events` — migration `0005`

```sql
ALTER TABLE calendar_events ADD COLUMN source_id TEXT REFERENCES calendar_sources(id);
```

- `source_id IS NULL` → locally created event (editable, deletable by user)
- `source_id IS NOT NULL` → synced event (read-only; local edits like `linked_note_id` preserved)

The `external_id` column already exists and is `UNIQUE` — used to identify events across re-syncs.
Compound key format: `{source_id}:{provider_event_id}` (e.g. `01ARZ3NDEKTSV4RRFFQ69G5FAV:abc123@google.com`).

---

## 6. Sync Engine

### 6.1 `syncSource()` — Core Function

```typescript
// src/main/calendar/sync/engine.ts

async function syncSource(db: Database, source: CalendarSource): Promise<number> {
  const provider = getProvider(source.provider_id)
  if (!provider) throw new Error(`Unknown provider: ${source.provider_id}`)

  const config = JSON.parse(source.config)
  const from   = subDays(new Date(), 7)   // 7 days back
  const to     = addDays(new Date(), 90)  // 90 days ahead

  const events = await provider.fetchEvents(config, from, to)

  let upsertCount = 0
  for (const ev of events) {
    const externalId = `${source.id}:${ev.externalId}`
    db.prepare(`
      INSERT INTO calendar_events
        (external_id, source_id, title, start_at, end_at, attendees,
         recurrence_rule, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(external_id) DO UPDATE SET
        title           = excluded.title,
        start_at        = excluded.start_at,
        end_at          = excluded.end_at,
        attendees       = excluded.attendees,
        recurrence_rule = excluded.recurrence_rule,
        synced_at       = excluded.synced_at
    `).run(
      externalId, source.id, ev.title,
      ev.startAt, ev.endAt,
      JSON.stringify(ev.attendees),
      ev.recurrenceRule ?? null,
      new Date().toISOString()
    )
    upsertCount++
  }

  // Purge stale events: synced from this source but not in the latest fetch
  const freshIds = new Set(events.map(ev => `${source.id}:${ev.externalId}`))
  const stale = db.prepare(
    'SELECT id, external_id FROM calendar_events WHERE source_id = ?'
  ).all(source.id) as { id: number; external_id: string }[]

  for (const row of stale) {
    if (!freshIds.has(row.external_id)) {
      // Preserve rows that have a linked note — user has annotated this event
      const linked = db.prepare(
        'SELECT linked_note_id FROM calendar_events WHERE id = ?'
      ).get(row.id) as { linked_note_id: string | null }
      if (!linked?.linked_note_id) {
        db.prepare('DELETE FROM calendar_events WHERE id = ?').run(row.id)
      }
    }
  }

  // Record successful sync time
  db.prepare('UPDATE calendar_sources SET last_sync_at = ? WHERE id = ?')
    .run(new Date().toISOString(), source.id)

  return upsertCount
}
```

### 6.2 Background Scheduler

```typescript
// src/main/calendar/sync/scheduler.ts

const _running = new Set<string>()  // source IDs currently syncing

export function startCalendarSyncScheduler(): void {
  setInterval(syncDue, 60_000)  // tick every minute
  syncDue()                     // also run at startup
}

async function syncDue(): Promise<void> {
  const db      = getDatabase()
  const sources = db.prepare(
    'SELECT * FROM calendar_sources WHERE enabled = 1'
  ).all() as CalendarSource[]

  for (const source of sources) {
    if (_running.has(source.id)) continue

    const intervalMs = source.sync_interval_minutes * 60_000
    const lastSync   = source.last_sync_at ? new Date(source.last_sync_at).getTime() : 0
    if (Date.now() - lastSync < intervalMs) continue

    _running.add(source.id)
    syncSource(db, source)
      .then(count => {
        pushToRenderer('calendar-sync:complete', { sourceId: source.id, count })
      })
      .catch(err => {
        console.error(`[CalSync] source ${source.id} failed:`, err)
        pushToRenderer('calendar-sync:error', { sourceId: source.id, message: err.message })
      })
      .finally(() => _running.delete(source.id))
  }
}
```

---

## 7. Google Apps Script Provider

### 7.1 Apps Script Code (user installs this)

The app displays this script for the user to paste into [script.google.com](https://script.google.com):

```javascript
function doGet(e) {
  var p = e.parameter;

  // Verification endpoint (?verify=1)
  if (p.verify === '1') {
    var cals = CalendarApp.getAllCalendars().map(function(c) {
      return { id: c.getId(), name: c.getName(), primary: c.isMyPrimaryCalendar() };
    });
    return json({ ok: true, email: Session.getActiveUser().getEmail(), calendars: cals });
  }

  // Events endpoint (?from=ISO&to=ISO&calendars=id1,id2)
  var from   = new Date(p.from);
  var to     = new Date(p.to);
  var calIds = (p.calendars || 'primary').split(',');
  var events = [];

  for (var i = 0; i < calIds.length; i++) {
    var calId = calIds[i].trim();
    var cal   = (calId === 'primary')
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(calId);
    if (!cal) continue;

    var items = cal.getEvents(from, to);
    for (var j = 0; j < items.length; j++) {
      var ev = items[j];
      events.push({
        id:         ev.getId(),
        calendarId: cal.getId(),
        title:      ev.getTitle(),
        startAt:    ev.getStartTime().toISOString(),
        endAt:      ev.getEndTime().toISOString(),
        isAllDay:   ev.isAllDayEvent(),
        attendees:  ev.getGuestList(true).map(function(g) {
          return { email: g.getEmail(), name: g.getName() || null };
        })
      });
    }
  }

  return json({ events: events });
}

function json(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
```

**Deployment instructions (shown in Settings UI):**

1. Go to [script.google.com](https://script.google.com) → **New project**
2. Paste the script above, replacing any existing code
3. Click **Deploy → New deployment** → Type: **Web app**
4. Set **Execute as**: *Me* | **Who has access**: *Only myself*
5. Click **Deploy** — authorize when prompted — copy the Web App URL
6. Paste the URL into Wizz and click **Test Connection**

### 7.2 Provider Implementation

```typescript
// src/main/calendar/sync/providers/googleAppsScript.ts

export const googleAppsScriptProvider: CalendarProvider = {
  id:   'google_apps_script',
  name: 'Google Apps Script',

  async verify(config) {
    const url = `${config.webAppUrl}?verify=1`
    try {
      const res  = await fetch(url)
      const data = await res.json() as { ok: boolean; email: string; calendars: { id: string; name: string }[] }
      return { ok: true, displayName: data.email, calendars: data.calendars }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  },

  async fetchEvents(config, from, to) {
    const calIds = config.calendarIds || 'primary'
    const url    = `${config.webAppUrl}?from=${from.toISOString()}&to=${to.toISOString()}&calendars=${encodeURIComponent(calIds)}`
    const res    = await fetch(url)
    const data   = await res.json() as { events: any[] }
    return (data.events ?? []).map((ev): ExternalEvent => ({
      externalId: ev.id,
      calendarId: ev.calendarId,
      title:      ev.title,
      startAt:    ev.startAt,
      endAt:      ev.endAt,
      isAllDay:   ev.isAllDay ?? false,
      attendees:  ev.attendees ?? [],
    }))
  }
}
```

---

## 8. iCal Provider Stub (Future)

```typescript
// src/main/calendar/sync/providers/ical.ts
// Dependencies: npm install node-ical

export const icalProvider: CalendarProvider = {
  id:   'ical',
  name: 'iCal / .ics URL',

  async verify(config) {
    // Fetch URL, parse first few lines, check for VCALENDAR header
  },
  async fetchEvents(config, from, to) {
    // node-ical parse, filter VEVENT components by date range
  }
}
```

---

## 9. IPC Handlers

New handlers registered in `src/main/db/ipc.ts`:

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `calendar-sources:list` | invoke | — | `CalendarSource[]` |
| `calendar-sources:create` | invoke | `{ provider_id, name, config, sync_interval_minutes }` | `CalendarSource` |
| `calendar-sources:update` | invoke | `{ id, name?, config?, enabled?, sync_interval_minutes? }` | `{ ok }` |
| `calendar-sources:delete` | invoke | `{ id }` | `{ ok }` (deletes synced events without linked notes) |
| `calendar-sources:verify` | invoke | `{ provider_id, config }` | `VerifyResult` |
| `calendar-sources:sync-now` | invoke | `{ id }` | `{ ok, count }` |
| `calendar-sync:complete` | push | `{ sourceId, count }` | — |
| `calendar-sync:error` | push | `{ sourceId, message }` | — |

**`CalendarSource` type** (exported from provider.ts):
```typescript
interface CalendarSource {
  id:                    string
  provider_id:           'google_apps_script' | 'ical' | 'google_api' | 'outlook'
  name:                  string
  config:                string   // raw JSON string stored in DB
  enabled:               boolean
  sync_interval_minutes: number   // 15 | 30 | 60 | 360 | 1440
  last_sync_at:          string | null
  created_at:            string
}
```

---

## 10. Settings UI — Calendar → Sync Tab

New subtab in `SettingsModal.vue` → Calendar category → **Sync** tab.

```
┌─ Calendar ───────────────────────────────────────────┐
│  General  |  Sync  |  Attendees                      │
│ ─────────────────────────────────────────────────── │
│  Calendar Sources                      [+ Add source] │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │ ●  Work Calendar (Google Apps Script)         │   │
│  │    Last sync: 5 minutes ago · Every 60 min    │   │
│  │    [Sync Now]  [Edit]  [Remove]               │   │
│  └───────────────────────────────────────────────┘   │
│                                                       │
│  ┌───────────────────────────────────────────────┐   │
│  │ ○  Team Shared (Google Apps Script) — off     │   │
│  │    Never synced · Every 360 min               │   │
│  │    [Sync Now]  [Edit]  [Remove]               │   │
│  └───────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────┘
```

### Add/Edit Source Modal (`CalendarSourceModal.vue`)

```
Step 1 — Choose provider:
  ● Google Apps Script  (recommended — no API key needed)
  ○ iCal URL            (coming soon)
  ○ Google Calendar API (coming soon)
  ○ Microsoft Outlook   (coming soon)

Step 2 — Configure:
  Name:       [Work Google Calendar          ]
  Sync every: [60 min ▼]   (15 / 30 / 60 / 360 / 1440)

  Web App URL:
  [https://script.google.com/macros/s/.../exec          ]
  [Test Connection]  → ✅ Connected as alice@gmail.com

  Calendars (select which to sync):
    ☑ My Calendar  (alice@gmail.com)     — primary
    ☑ Team Shared  (team@company.com)
    ☐ Holidays in Poland

  ▶ Setup instructions  (collapsible)
    1. Go to script.google.com → New project
    2. Paste the script below, replacing all existing code
    3. Deploy → New deployment → Web app
       Execute as: Me · Who has access: Only myself
    4. Copy the Web App URL and paste it above

    [Script code block with copy button]

  [Cancel]                          [Save source]
```

---

## 11. CalendarView Integration

- Synced events display a subtle visual indicator (e.g. small external-link icon badge, or a
  dashed left border in the provider's color) to distinguish them from locally created events
- Clicking a synced event opens a **read-only info popup** (not the edit modal):
  - Shows title, time, attendees, source name
  - "Link Meeting Notes" button and "Open Note →" link still functional
  - No edit/delete controls
- `linked_note_id` and `transcript_note_id` are preserved across re-syncs (the ON CONFLICT
  UPDATE clause does not overwrite those columns)
- `calendar-sync:complete` push event triggers a re-fetch of the currently visible date range

---

## 12. Future Phases

### Phase 2 — iCal URL provider
- Add `ical` provider using `node-ical` or `ical.js` (`npm install node-ical`)
- No new UI needed — provider appears enabled in the Add Source modal's picker

### Phase 3 — Google Calendar API (OAuth)
- Register a GCP OAuth app once (Wizz app client ID embedded in the binary)
- Electron PKCE OAuth flow via `shell.openExternal()` + local redirect server
- Access/refresh tokens stored encrypted in the `settings` table
- Enables write-back: create/update/delete events pushed back to Google
- Calendar list populated automatically from the API (no Apps Script required)

### Phase 4 — Microsoft Outlook / Graph API
- Same OAuth PKCE flow as Phase 3 but against Azure AD endpoints
- Same `CalendarProvider` interface — new provider file only

### Phase 5 — CRUD write-back (all providers that support it)
- `source_id IS NOT NULL` events become editable in the UI
- Local changes queued for write-back; conflict resolution strategy TBD
- Conflict options: server wins, local wins, user prompt

---

## 13. Implementation Checklist

### Phase A — Abstraction Layer & DB
- [x] Create `src/main/calendar/sync/provider.ts` — `CalendarProvider` interface, `ExternalEvent`, `VerifyResult`, `CalendarSource` types
- [x] Create `src/main/calendar/sync/registry.ts` — `PROVIDERS` map + `getProvider(id)`
- [x] Add `calendar_sources` table to `src/main/db/schema.ts` (`CREATE TABLE IF NOT EXISTS`)
- [x] Create migration `src/main/db/migrations/0005_calendar_sources.ts` — creates `calendar_sources` + adds `source_id` column on `calendar_events`
- [x] Register migration `0005` in `src/main/db/migrations/index.ts`

### Phase B — Google Apps Script Provider
- [x] Create `src/main/calendar/sync/providers/googleAppsScript.ts` — implements `CalendarProvider`: `verify()` + `fetchEvents()` using Node.js built-in `fetch`
- [x] Export Apps Script source code as a constant string from the provider file (used in Settings UI)

### Phase C — Sync Engine
- [x] Create `src/main/calendar/sync/engine.ts` — `syncSource(db, source)`: upsert events via `ON CONFLICT(external_id)`, stale-event purge (skip if `linked_note_id` set), `last_sync_at` update
- [x] Create `src/main/calendar/sync/scheduler.ts` — `startCalendarSyncScheduler()`: 60s `setInterval`, per-source interval check, per-source mutex via `Set<string>`

### Phase D — IPC Handlers
- [x] Add `calendar-sources:list` handler to `src/main/db/ipc.ts`
- [x] Add `calendar-sources:create` handler (ULID id, `created_at = NOW()`)
- [x] Add `calendar-sources:update` handler (dynamic SET, partial updates)
- [x] Add `calendar-sources:delete` handler (purge synced events without linked notes, then delete source)
- [x] Add `calendar-sources:verify` handler (calls provider `verify()`, no DB writes)
- [x] Add `calendar-sources:sync-now` handler (calls `syncSource()` directly, returns `{ ok, count }`)
- [x] Call `startCalendarSyncScheduler()` from `src/main/index.ts` at startup

### Phase E — Settings UI
- [x] Add **Sync** subtab to the Calendar category in `SettingsModal.vue`
- [x] Source list: provider badge, last-sync timestamp, enabled toggle, Sync Now / Edit / Remove buttons
- [x] Create `CalendarSourceModal.vue` — multi-step add/edit modal:
  - Step 1: provider picker (Apps Script active; others disabled with "coming soon" label)
  - Step 2: name field, sync interval dropdown (15/30/60/360/1440 min), Web App URL input
  - "Test Connection" button → calls `calendar-sources:verify` → shows success (email) or error
  - On verify success: render calendar list as checkboxes; selected IDs stored in `config.calendarIds`
  - Collapsible "Setup Instructions" with Apps Script code block + copy button + numbered steps
- [x] On `calendar-sync:complete` push: refresh `last_sync_at` display for that source in real time
- [x] On `calendar-sync:error` push: show inline error badge on the failing source card

### Phase F — CalendarView Integration
- [x] Add `.is-synced` CSS class to event blocks where `source_id IS NOT NULL`; teal color scheme + cloud icon
- [x] Synced events: clicking opens `SyncedEventPopup` (read-only); drag and resize blocked
- [x] `SyncedEventPopup.vue` — shows title, date/time, attendees, source name; link/unlink meeting notes
- [x] `linked_note_id` / `transcript_note_id` preserved across re-syncs (ON CONFLICT excludes those columns)
- [x] Listen to `calendar-sync:complete` push event → re-fetch events for currently visible date range
- [x] Update `CLAUDE.md` with new IPC channels, `calendar_sources` table, and component descriptions

---

*This document covers the read-only Phase 1. Write-back, iCal, and OAuth providers are tracked in §12 Future Phases.*
