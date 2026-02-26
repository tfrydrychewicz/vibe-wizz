import type { CalendarProvider, ExternalEvent, VerifyResult } from '../provider'

// ─── Apps Script source ────────────────────────────────────────────────────────
// User pastes this into script.google.com on their Workspace/calendar account.
// It pushes calendar events as JSON to a jsonbin.io bin; Wizz fetches the bin.

export const JSONBIN_SCRIPT_SOURCE = `\
// ── Configuration ─────────────────────────────────────────────────────────────
// 1. Paste your Master Key from jsonbin.io → Account → API Keys
var JSONBIN_API_KEY = 'YOUR_MASTER_KEY_HERE';

// 2. Leave blank on the first run — the Bin ID will be printed in Logs.
//    After the first run, paste the ID here so future runs update the same bin.
var BIN_ID = '';

// 3. Optional: comma-separated calendar IDs to include.
//    Leave empty ('') to export only your primary / default calendar.
//    To find a calendar ID: Google Calendar → Settings → <calendar> → Calendar ID.
//    Example: 'primary,abc123@group.calendar.google.com'
var CALENDAR_IDS = '';

var DAYS_BACK  = 7;   // how many past days to include
var DAYS_AHEAD = 90;  // how many future days to include

// ── Run this function manually (then set up a time trigger) ───────────────────
function syncCalendarToJsonbin() {
  var from = new Date(); from.setDate(from.getDate() - DAYS_BACK);
  var to   = new Date(); to.setDate(to.getDate()   + DAYS_AHEAD);

  var calIds = CALENDAR_IDS
    ? CALENDAR_IDS.split(',').map(function(s) { return s.trim(); })
    : ['primary'];

  var events = [];
  for (var c = 0; c < calIds.length; c++) {
    var calId = calIds[c].trim();
    var cal = (calId === 'primary')
      ? CalendarApp.getDefaultCalendar()
      : CalendarApp.getCalendarById(calId);
    if (!cal) continue;

    // getEvents() automatically expands recurring series into individual instances
    var items = cal.getEvents(from, to);
    for (var i = 0; i < items.length; i++) {
      var ev = items[i];

      // Only include events you have confirmed (or created yourself)
      var myStatus = ev.getMyStatus();
      if (myStatus !== CalendarApp.GuestStatus.YES &&
          myStatus !== CalendarApp.GuestStatus.OWNER) {
        continue;
      }

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

  var payload = JSON.stringify({ events: events, exportedAt: new Date().toISOString() });
  var headers = {
    'Content-Type': 'application/json',
    'X-Master-Key': JSONBIN_API_KEY
  };

  var response, result;
  if (BIN_ID) {
    // Update existing bin
    response = UrlFetchApp.fetch('https://api.jsonbin.io/v3/b/' + BIN_ID, {
      method: 'PUT',
      headers: headers,
      payload: payload,
      muteHttpExceptions: true
    });
    result = JSON.parse(response.getContentText());
    if (response.getResponseCode() !== 200) {
      Logger.log('Error: ' + result.message);
    } else {
      Logger.log('Updated bin ' + BIN_ID + ' — ' + events.length + ' events written');
    }
  } else {
    // Create new bin (public so Wizz can read without auth)
    var createHeaders = JSON.parse(JSON.stringify(headers));
    createHeaders['X-Bin-Name'] = 'wizz-calendar';
    createHeaders['X-Bin-Private'] = 'false';
    response = UrlFetchApp.fetch('https://api.jsonbin.io/v3/b', {
      method: 'POST',
      headers: createHeaders,
      payload: payload,
      muteHttpExceptions: true
    });
    result = JSON.parse(response.getContentText());
    if (response.getResponseCode() !== 200) {
      Logger.log('Error creating bin: ' + result.message);
    } else {
      var newId = result.metadata.id;
      Logger.log('Created bin — ' + events.length + ' events written');
      Logger.log('IMPORTANT: Set BIN_ID = "' + newId + '" in this script, then paste into Wizz: ' + newId);
    }
  }
}
`

// ─── Deployment instructions shown in the Settings UI ─────────────────────────

export const JSONBIN_INSTRUCTIONS = [
  'Sign up at jsonbin.io → go to Account → API Keys → copy your Master Key',
  'Open script.google.com → New project → paste the script above',
  'Set JSONBIN_API_KEY to your Master Key; optionally set CALENDAR_IDS',
  'Click Run → syncCalendarToJsonbin (grant Calendar permissions when prompted)',
  'Open View → Logs — copy the Bin ID from the "IMPORTANT" line',
  'Paste that Bin ID back into the BIN_ID variable in the script (so future runs update it)',
  'Paste the Bin ID into Wizz, click Test Connection, then Save',
  'Optional: add a time trigger — click the clock icon → Add Trigger → syncCalendarToJsonbin → Hour timer → Every hour',
] as const

// ─── jsonbin response shapes ───────────────────────────────────────────────────

interface JsonbinRecord {
  events: {
    id: string
    calendarId: string
    title: string
    startAt: string
    endAt: string
    isAllDay: boolean
    attendees: { email: string; name: string | null }[]
  }[]
  exportedAt?: string
}

// ─── Provider implementation ──────────────────────────────────────────────────

export const jsonbinProvider: CalendarProvider = {
  id: 'jsonbin',
  name: 'JSONBin.io',

  async verify(config): Promise<VerifyResult> {
    const { binId, accessKey } = config
    if (!binId?.trim()) {
      return { ok: false, error: 'Bin ID is required.' }
    }

    const headers: Record<string, string> = {}
    if (accessKey?.trim()) headers['X-Master-Key'] = accessKey.trim()

    let res: Response
    try {
      res = await fetch(`https://api.jsonbin.io/v3/b/${binId.trim()}/latest`, {
        headers,
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Connection failed: ${msg}` }
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          error: 'Access denied. If this is a private bin, paste your Master Key into the Access Key field.',
        }
      }
      return {
        ok: false,
        error: `JSONBin returned ${res.status} ${res.statusText}. Check that the Bin ID is correct.`,
      }
    }

    let body: { record: JsonbinRecord }
    try {
      body = await res.json() as { record: JsonbinRecord }
    } catch {
      return { ok: false, error: 'Could not parse JSONBin response.' }
    }

    const events = body?.record?.events
    if (!Array.isArray(events)) {
      return {
        ok: false,
        error:
          'Bin does not contain a Wizz calendar export. ' +
          'Make sure you ran syncCalendarToJsonbin() and copied the correct Bin ID.',
      }
    }

    const eventCount = events.length
    return {
      ok: true,
      displayName: `${eventCount} event${eventCount !== 1 ? 's' : ''}`,
    }
  },

  async fetchEvents(config, from, to): Promise<ExternalEvent[]> {
    const { binId, accessKey } = config
    if (!binId?.trim()) {
      throw new Error('JSONBin provider: binId is not configured.')
    }

    const headers: Record<string, string> = {}
    if (accessKey?.trim()) headers['X-Master-Key'] = accessKey.trim()

    let res: Response
    try {
      res = await fetch(`https://api.jsonbin.io/v3/b/${binId.trim()}/latest`, {
        headers,
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`JSONBin fetch failed: ${msg}`)
    }

    if (!res.ok) {
      throw new Error(`JSONBin returned ${res.status} ${res.statusText}`)
    }

    const body = await res.json() as { record: JsonbinRecord }
    const allEvents = body?.record?.events
    if (!Array.isArray(allEvents)) return []

    const fromMs = from.getTime()
    const toMs   = to.getTime()
    const events: ExternalEvent[] = []

    for (const ev of allEvents) {
      const startMs = ev.startAt ? new Date(ev.startAt).getTime() : 0
      const endMs   = ev.endAt   ? new Date(ev.endAt).getTime()   : 0

      if (endMs <= fromMs || startMs >= toMs) continue

      const attendees = (ev.attendees ?? []).map((a) => ({
        email: a.email,
        ...(a.name ? { name: a.name } : {}),
      }))

      events.push({
        externalId: ev.id ?? `ev-${events.length}`,
        calendarId: ev.calendarId || 'jsonbin',
        title:      ev.title || '(No title)',
        startAt:    ev.startAt,
        endAt:      ev.endAt,
        isAllDay:   ev.isAllDay ?? false,
        attendees,
      })
    }

    return events
  },
}
