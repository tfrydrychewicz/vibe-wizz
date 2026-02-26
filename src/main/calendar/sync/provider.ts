/**
 * Provider abstraction for external calendar integrations.
 *
 * A CalendarProvider encapsulates all communication with one external
 * calendar system (Google Apps Script, iCal, Google API, Outlook, …).
 * The sync engine talks only to this interface, so adding a new provider
 * is adding a new file — nothing in the engine changes.
 */

// ─── Shared event shape returned by every provider ────────────────────────────

export interface ExternalEvent {
  /** Provider-unique event ID (will be namespaced with source ID before storage). */
  externalId: string
  /** Which calendar within the provider this event belongs to. */
  calendarId: string
  title: string
  /** ISO 8601 timestamp. */
  startAt: string
  /** ISO 8601 timestamp. */
  endAt: string
  isAllDay: boolean
  attendees: { name?: string | null; email: string }[]
  /** RFC 5545 RRULE string, if the event is recurring. */
  recurrenceRule?: string
  description?: string
}

// ─── Verification result ──────────────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  /** Human-readable error when ok=false. */
  error?: string
  /** Authenticated account name / email shown to the user after a successful test. */
  displayName?: string
  /** Calendars discovered during verification (used to populate the calendar picker). */
  calendars?: { id: string; name: string; primary?: boolean }[]
}

// ─── Provider interface ───────────────────────────────────────────────────────

export interface CalendarProvider {
  /** Stable machine identifier, e.g. 'google_apps_script' | 'ical' | 'google_api' | 'outlook'. */
  readonly id: string
  /** Display name shown in the Settings UI. */
  readonly name: string

  /**
   * Test connectivity and discover available calendars.
   * Must be side-effect-free (no DB writes).
   */
  verify(config: Record<string, string>): Promise<VerifyResult>

  /**
   * Fetch all events whose time range overlaps [from, to].
   * Recurring events may be returned as expanded occurrences or as a single
   * rule-bearing event — the engine stores whatever is returned.
   */
  fetchEvents(config: Record<string, string>, from: Date, to: Date): Promise<ExternalEvent[]>
}

// ─── DB row shape for calendar_sources ────────────────────────────────────────

export interface CalendarSource {
  id: string
  provider_id: string
  name: string
  /** Raw JSON string stored in the DB — parse before use. */
  config: string
  enabled: number   // SQLite boolean: 1 | 0
  sync_interval_minutes: number
  last_sync_at: string | null
  created_at: string
}
