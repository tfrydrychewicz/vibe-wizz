import type { CalendarProvider, ExternalEvent, VerifyResult } from '../provider'

// ─── Apps Script source ────────────────────────────────────────────────────────
// This string is shown verbatim in the Settings UI so the user can copy-paste
// it into script.google.com. Keep it self-contained — no external dependencies.

export const APPS_SCRIPT_SOURCE = `\
function doGet(e) {
  var p = e.parameter;

  // Verification endpoint — called by Wizz to test connectivity
  if (p.verify === '1') {
    var cals = CalendarApp.getAllCalendars().map(function(c) {
      return { id: c.getId(), name: c.getName(), primary: c.isMyPrimaryCalendar() };
    });
    return json({ ok: true, email: Session.getActiveUser().getEmail(), calendars: cals });
  }

  // Events endpoint — called periodically to sync calendar data
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
}`

// ─── Deployment instructions shown in the Settings UI ─────────────────────────

export const APPS_SCRIPT_INSTRUCTIONS = [
  'Sign in to a personal @gmail.com account at script.google.com (Workspace/company accounts may block public deployments)',
  'Create a new project and replace all existing code with the script above',
  'Click Deploy → New deployment → Type: Web app',
  'Set Execute as: Me  ·  Who has access: Anyone',
  'Click Deploy, authorize when prompted, then copy the Web App URL',
  'Paste the URL into Wizz and click Test Connection',
  'To include work calendars: share them to your Gmail account from Google Calendar → Settings → Share with specific people',
] as const

// ─── Response shapes from the Apps Script ────────────────────────────────────

interface VerifyResponse {
  ok: boolean
  email: string
  calendars: { id: string; name: string; primary: boolean }[]
}

interface EventsResponse {
  events: {
    id: string
    calendarId: string
    title: string
    startAt: string
    endAt: string
    isAllDay: boolean
    attendees: { email: string; name: string | null }[]
  }[]
  error?: string
}

// ─── Provider implementation ──────────────────────────────────────────────────

export const googleAppsScriptProvider: CalendarProvider = {
  id: 'google_apps_script',
  name: 'Google Apps Script',

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
        error: `Server returned ${res.status} ${res.statusText}. Check that the Web App is deployed and accessible.`,
      }
    }

    let body: string
    try {
      body = await res.text()
    } catch {
      return { ok: false, error: 'Could not read response body.' }
    }

    // Google returns an HTML login page when "Who has access" is not set to "Anyone".
    // Workspace accounts may not have the "Anyone" option — use a personal @gmail.com account instead.
    if (body.trimStart().startsWith('<')) {
      return {
        ok: false,
        error:
          'Received an HTML page instead of JSON. Make sure "Who has access" is set to Anyone in the deployment. ' +
          'If you only see "Only myself" or "Anyone within [org]", your Google Workspace blocks public deployments — ' +
          'deploy the script from a personal @gmail.com account instead.',
      }
    }

    let data: VerifyResponse
    try {
      data = JSON.parse(body) as VerifyResponse
    } catch {
      return {
        ok: false,
        error: `Could not parse response as JSON. Make sure the script code is deployed correctly. Response preview: ${body.slice(0, 120)}`,
      }
    }

    if (!data.ok) {
      return { ok: false, error: 'Script returned ok=false. Check the deployment settings.' }
    }

    return {
      ok: true,
      displayName: data.email,
      calendars: data.calendars.map(c => ({ id: c.id, name: c.name, primary: c.primary })),
    }
  },

  async fetchEvents(config, from, to): Promise<ExternalEvent[]> {
    const { webAppUrl, calendarIds } = config
    if (!webAppUrl?.trim()) {
      throw new Error('Google Apps Script provider: webAppUrl is not configured.')
    }

    const params = new URLSearchParams({
      from: from.toISOString(),
      to: to.toISOString(),
      ...(calendarIds?.trim() ? { calendars: calendarIds.trim() } : {}),
    })

    let res: Response
    try {
      res = await fetch(`${webAppUrl.trim()}?${params}`, {
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`Google Apps Script fetch failed: ${msg}`)
    }

    if (!res.ok) {
      throw new Error(
        `Google Apps Script returned ${res.status} ${res.statusText}`
      )
    }

    const data = (await res.json()) as EventsResponse

    if (data.error) {
      throw new Error(`Google Apps Script error: ${data.error}`)
    }

    return (data.events ?? []).map((ev): ExternalEvent => ({
      externalId: ev.id,
      calendarId: ev.calendarId,
      title: ev.title || '(No title)',
      startAt: ev.startAt,
      endAt: ev.endAt,
      isAllDay: ev.isAllDay ?? false,
      attendees: (ev.attendees ?? []).map(a => ({
        email: a.email,
        ...(a.name ? { name: a.name } : {}),
      })),
    }))
  },
}
