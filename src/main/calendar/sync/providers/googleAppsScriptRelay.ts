import type { CalendarProvider, ExternalEvent, VerifyResult } from '../provider'

// ─── Personal account script (receiver + server) ──────────────────────────────
// Deploy this on your PERSONAL Google account as a Web App.
// It stores whatever the corp script POSTs, and serves it back to Wizz via GET.

export const RELAY_PERSONAL_SCRIPT_SOURCE = `\
// ── Personal account script — deploy this as a Web App ────────────────────────
// Execute as: Me
// Who has access: Anyone
//
// This script acts as a relay: it accepts calendar data POSTed by the corp
// script and stores it in your Drive, then serves it back to Wizz via GET.

var FILE_NAME = 'wizz-calendar-relay.json';

// POST — called by the corp script to push calendar data
function doPost(e) {
  try {
    var json = e.postData.contents;
    var data = JSON.parse(json); // validate JSON

    var files = DriveApp.getFilesByName(FILE_NAME);
    if (files.hasNext()) {
      files.next().setContent(json);
    } else {
      DriveApp.createFile(FILE_NAME, json, MimeType.PLAIN_TEXT);
    }

    var count = Array.isArray(data.events) ? data.events.length : 0;
    return out({ ok: true, count: count });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

// GET — called by Wizz to fetch the latest calendar data
function doGet(e) {
  if (e.parameter.verify === '1') {
    var files = DriveApp.getFilesByName(FILE_NAME);
    if (!files.hasNext()) {
      return out({ ok: false, error: 'No calendar data yet. Run the corp script first.' });
    }
    try {
      var data = JSON.parse(files.next().getBlob().getDataAsString());
      var count = Array.isArray(data.events) ? data.events.length : 0;
      return out({ ok: true, count: count, exportedAt: data.exportedAt || null });
    } catch (err) {
      return out({ ok: false, error: 'Stored file is not valid JSON: ' + String(err) });
    }
  }

  var files = DriveApp.getFilesByName(FILE_NAME);
  if (!files.hasNext()) {
    return out({ events: [], exportedAt: null });
  }
  // Return raw stored content (already valid JSON)
  return ContentService
    .createTextOutput(files.next().getBlob().getDataAsString())
    .setMimeType(ContentService.MimeType.JSON);
}

function out(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
`

// ─── Corp account script (sender) ─────────────────────────────────────────────
// Run this on the CORP Google Workspace account that owns the calendar.
// It does NOT need to be deployed as a Web App — just run it manually or via trigger.

export const RELAY_CORP_SCRIPT_SOURCE = `\
// ── Corp account script — run on the Workspace account that owns the calendar ──
// Uses the Advanced Calendar Service for full attendee data and reliable recurrence expansion.
// This script does NOT need to be deployed as a Web App.
//
// IMPORTANT: Enable the Advanced Calendar Service before running:
//   Apps Script sidebar → + (Add a service) → Google Calendar API → Add

// 1. Paste the Web App URL from your personal account script here:
var PERSONAL_WEBAPP_URL = 'YOUR_PERSONAL_WEBAPP_URL_HERE';

// 2. Comma-separated calendar IDs to include (use the email address of the calendar).
//    Example: 'me@corp.com,team@corp.com'
var CALENDAR_IDS = '';

var DAYS_BACK  = 7;   // how many past days to include
var DAYS_AHEAD = 90;  // how many future days to include

function syncCalendarToRelay() {
  console.log('--- Starting Sync ---');

  var from = new Date(); from.setDate(from.getDate() - DAYS_BACK);
  var to   = new Date(); to.setDate(to.getDate() + DAYS_AHEAD);

  var calIds = CALENDAR_IDS
    ? CALENDAR_IDS.split(',').map(function(s) { return s.trim(); })
    : ['primary'];

  var allEvents = [];

  calIds.forEach(function(calId) {
    console.log('Fetching batch data for: ' + calId);

    // Advanced Calendar Service fetches metadata AND attendees in one request.
    // singleEvents: true expands recurring series into individual instances.
    var optionalArgs = {
      timeMin:      from.toISOString(),
      timeMax:      to.toISOString(),
      showDeleted:  false,
      singleEvents: true,
      orderBy:      'startTime'
    };

    try {
      var response = Calendar.Events.list(calId, optionalArgs);
      var items = response.items;

      if (!items || items.length === 0) {
        console.log('No events found for ' + calId);
        return;
      }

      console.log('Processing ' + items.length + ' raw items...');

      items.forEach(function(ev) {
        // FILTER 1: Standard meetings only — skip workingLocation, focusTime, outOfOffice
        if (ev.eventType !== 'default') return;

        // FILTER 2: RSVP status — accepted, tentative, or organizer (no attendees list)
        var self = ev.attendees ? ev.attendees.find(function(a) { return a.self; }) : null;
        var myStatus = self ? self.responseStatus : 'accepted';
        if (myStatus !== 'accepted' && myStatus !== 'tentative') return;

        allEvents.push({
          id:         ev.id,
          calendarId: calId,
          title:      ev.summary  || '(No Title)',
          startAt:    ev.start.dateTime || ev.start.date,
          endAt:      ev.end.dateTime   || ev.end.date,
          isAllDay:   !!ev.start.date,
          location:   ev.location || '',
          attendees:  (ev.attendees || []).map(function(g) {
            return { email: g.email, name: g.displayName || g.email.split('@')[0] };
          })
        });
      });
    } catch (e) {
      console.error('Error fetching calendar ' + calId + ': ' + e.toString());
    }
  });

  console.log('Total filtered events to send: ' + allEvents.length);

  var payload = JSON.stringify({ events: allEvents, exportedAt: new Date().toISOString() });
  console.log('Payload size: ' + (payload.length / 1024).toFixed(2) + ' KB');

  var fetchResponse = UrlFetchApp.fetch(PERSONAL_WEBAPP_URL, {
    method: 'POST',
    contentType: 'application/json',
    payload: payload,
    muteHttpExceptions: true
  });

  var result = JSON.parse(fetchResponse.getContentText());
  if (result.ok) {
    console.log('SUCCESS: Sent ' + allEvents.length + ' events to relay.');
  } else {
    console.error('RELAY ERROR: ' + result.error);
  }

  console.log('--- Sync Finished ---');
}
`

// ─── Setup instructions ───────────────────────────────────────────────────────

export const RELAY_INSTRUCTIONS = [
  'Open script.google.com on your PERSONAL Google account → New project → paste Script 1 (Personal)',
  'Click Deploy → New deployment → Type: Web app → Execute as: Me → Who has access: Anyone → Deploy',
  'Copy the Web App URL — you will need it in the next step and in Wizz',
  'Open script.google.com on your CORP Workspace account → New project → paste Script 2 (Corp)',
  'In the Corp project: click the + icon next to "Services" → search "Google Calendar API" → Add (this enables the Advanced Calendar Service)',
  'Set PERSONAL_WEBAPP_URL to the URL from step 3; set CALENDAR_IDS to your corp calendar email(s)',
  'Click Run → syncCalendarToRelay (grant Calendar permissions when prompted)',
  'Open View → Execution log — you should see "Total events collected: N" and "Sent N events to relay"',
  'Paste the Personal Web App URL into Wizz, click Test Connection, then Save',
  'Optional: add a time trigger on the CORP script — click the clock icon → Add Trigger → syncCalendarToRelay → Hour timer → Every hour',
] as const

// ─── Provider implementation ──────────────────────────────────────────────────

export const googleAppsScriptRelayProvider: CalendarProvider = {
  id: 'google_apps_script_relay',
  name: 'Apps Script Relay',

  async verify(config): Promise<VerifyResult> {
    const { webAppUrl } = config
    if (!webAppUrl?.trim()) {
      return { ok: false, error: 'Web App URL is required.' }
    }

    let res: Response
    try {
      res = await fetch(`${webAppUrl.trim()}?verify=1`, {
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: `Connection failed: ${msg}` }
    }

    if (!res.ok) {
      return {
        ok: false,
        error: `Server returned ${res.status} ${res.statusText}. Check that the personal Web App URL is correct and deployed as "Anyone".`,
      }
    }

    let data: { ok: boolean; count?: number; exportedAt?: string | null; error?: string }
    try {
      data = await res.json() as typeof data
    } catch {
      return { ok: false, error: 'Could not parse response. Make sure the personal script is deployed correctly.' }
    }

    if (!data.ok) {
      return { ok: false, error: data.error ?? 'Relay script returned an error.' }
    }

    const count = data.count ?? 0
    return {
      ok: true,
      displayName: `${count} event${count !== 1 ? 's' : ''} in relay`,
    }
  },

  async fetchEvents(config, from, to): Promise<ExternalEvent[]> {
    const { webAppUrl } = config
    if (!webAppUrl?.trim()) {
      throw new Error('Apps Script Relay provider: webAppUrl is not configured.')
    }

    let res: Response
    try {
      res = await fetch(webAppUrl.trim(), { signal: AbortSignal.timeout(30_000) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Relay fetch failed: ${msg}`)
    }

    if (!res.ok) {
      throw new Error(`Relay returned ${res.status} ${res.statusText}`)
    }

    const body = await res.json() as { events?: unknown[] }
    const allEvents = body?.events
    if (!Array.isArray(allEvents)) return []

    const fromMs = from.getTime()
    const toMs   = to.getTime()
    const events: ExternalEvent[] = []

    for (const ev of allEvents as Record<string, unknown>[]) {
      const startAt = typeof ev.startAt === 'string' ? ev.startAt : ''
      const endAt   = typeof ev.endAt   === 'string' ? ev.endAt   : ''

      const startMs = startAt ? new Date(startAt).getTime() : 0
      const endMs   = endAt   ? new Date(endAt).getTime()   : 0

      if (endMs <= fromMs || startMs >= toMs) continue

      const rawAttendees = Array.isArray(ev.attendees) ? ev.attendees as { email: string; name: string | null }[] : []
      const attendees = rawAttendees.map((a) => ({
        email: a.email,
        ...(a.name ? { name: a.name } : {}),
      }))

      events.push({
        externalId: typeof ev.id === 'string' ? ev.id : `ev-${events.length}`,
        calendarId: typeof ev.calendarId === 'string' ? ev.calendarId : 'relay',
        title:      typeof ev.title === 'string' ? ev.title : '(No title)',
        startAt,
        endAt,
        isAllDay:   ev.isAllDay === true,
        attendees,
      })
    }

    return events
  },
}
