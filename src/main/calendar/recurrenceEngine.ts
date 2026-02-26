/**
 * recurrenceEngine.ts
 *
 * Pure-TypeScript engine for recurring calendar events.
 * No external dependencies — only better-sqlite3 for DB access.
 *
 * Concepts:
 *   Series root  — the original event row with recurrence_rule set.
 *                  Appears on the calendar as the first occurrence.
 *                  recurrence_series_id IS NULL on the root.
 *   Occurrence   — a generated row for one instance of the series.
 *                  recurrence_series_id = root.id
 *                  recurrence_instance_date = 'YYYY-MM-DD'
 */

import type Database from 'better-sqlite3'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DayAbbr = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'

export interface RecurrenceRule {
  /** Repetition frequency */
  freq: 'daily' | 'weekly' | 'biweekly' | 'monthly'
  /**
   * Days of the week on which the event recurs (weekly / biweekly only).
   * Defaults to the day of start_at when not provided.
   */
  days?: DayAbbr[]
  /** Inclusive end date (YYYY-MM-DD). Mutually exclusive with count. */
  until?: string
  /** Maximum total occurrences across the whole series. Mutually exclusive with until. */
  count?: number
}

export type UpdateScope = 'this' | 'future' | 'all'
export type DeleteScope = 'this' | 'future' | 'all'

/** Rolling window (months) used when generating future occurrences. */
export const RECURRENCE_WINDOW_MONTHS = 6

// ─── Rule helpers ─────────────────────────────────────────────────────────────

const DAY_ABBR_TO_INDEX: Record<DayAbbr, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
}

const INDEX_TO_DAY_ABBR: DayAbbr[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function dayAbbrToIndex(d: DayAbbr): number {
  return DAY_ABBR_TO_INDEX[d]
}

function dayIndexToAbbr(i: number): DayAbbr {
  return INDEX_TO_DAY_ABBR[i % 7]
}

/** Parse and validate a recurrence_rule JSON string. Returns null if invalid. */
export function parseRecurrenceRule(json: string): RecurrenceRule | null {
  try {
    const obj = JSON.parse(json) as RecurrenceRule
    if (!['daily', 'weekly', 'biweekly', 'monthly'].includes(obj.freq)) return null
    return obj
  } catch {
    return null
  }
}

/** Describe a rule in human-readable English. */
export function describeRecurrenceRule(rule: RecurrenceRule): string {
  const days =
    rule.days && rule.days.length > 0
      ? rule.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
      : null

  switch (rule.freq) {
    case 'daily':
      return 'Daily'
    case 'weekly':
      return days ? `Weekly on ${days}` : 'Weekly'
    case 'biweekly':
      return days ? `Every 2 weeks on ${days}` : 'Every 2 weeks'
    case 'monthly':
      return 'Monthly'
  }
}

// ─── Date utilities ───────────────────────────────────────────────────────────

/** Format a Date as YYYY-MM-DD (local time, no UTC shift). */
function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parse a YYYY-MM-DD string into a local Date at midnight. */
function parseISODate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Add `n` months to a date, clamping to the last day of the target month. */
function addMonths(d: Date, n: number): Date {
  const result = new Date(d)
  const targetMonth = result.getMonth() + n
  result.setMonth(targetMonth)
  // If month overflowed (e.g. Jan 31 + 1 month), setMonth may jump ahead;
  // detect and clamp back.
  const expected = ((d.getMonth() + n) % 12 + 12) % 12
  if (result.getMonth() !== expected) {
    result.setDate(0) // Last day of the previous (correct) month
  }
  return result
}

/**
 * Build an ISO datetime string for an occurrence on `date` (YYYY-MM-DD) that
 * preserves the same LOCAL time-of-day as `rootStartAt`.
 *
 * rootStartAt is stored as UTC (with Z) because MeetingModal uses toISOString().
 * new Date(rootStartAt).getHours() returns the LOCAL hour, so we reconstruct the
 * occurrence at LOCAL midnight + root's local H:M:S, then convert back to UTC via
 * toISOString().  This keeps occurrences at the same clock time in the user's TZ.
 */
function occurrenceStart(date: string, rootDate: Date): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, rootDate.getHours(), rootDate.getMinutes(), rootDate.getSeconds(), 0)
}

// ─── Date expansion ───────────────────────────────────────────────────────────

/**
 * Expand a recurrence rule into an array of ISO dates (YYYY-MM-DD) that fall
 * within [fromDate, toDate] (both inclusive) and are on or after seriesStart.
 *
 * The caller is responsible for not passing dates before the series start.
 * Does NOT include the series root's own start date (that is handled separately).
 */
export function expandDates(
  seriesStartAt: string,
  rule: RecurrenceRule,
  fromDate: string,
  toDate: string,
): string[] {
  const seriesStart = parseISODate(seriesStartAt.split('T')[0])
  const from = parseISODate(fromDate)
  const to = parseISODate(toDate)
  const until = rule.until ? parseISODate(rule.until) : null
  const maxCount = rule.count ?? Infinity

  // Effective end: the earlier of `to` and `until`
  const effectiveEnd = until && until < to ? until : to

  const results: string[] = []
  const MS_PER_DAY = 24 * 60 * 60 * 1000

  if (rule.freq === 'daily') {
    // Start the iteration from the day AFTER the series root (root itself is not an occurrence)
    let cur = new Date(seriesStart.getTime() + MS_PER_DAY)
    while (cur <= effectiveEnd && results.length < maxCount) {
      if (cur >= from) results.push(toISODate(cur))
      cur = new Date(cur.getTime() + MS_PER_DAY)
    }
  } else if (rule.freq === 'weekly' || rule.freq === 'biweekly') {
    const intervalDays = rule.freq === 'biweekly' ? 14 : 7
    const targetDays: number[] =
      rule.days && rule.days.length > 0
        ? rule.days.map(dayAbbrToIndex)
        : [seriesStart.getDay()]

    // Sorted so we emit dates in chronological order within each week
    const sortedTargetDays = [...new Set(targetDays)].sort((a, b) => a - b)

    // Find the Monday of the week containing seriesStart
    const seriesDow = seriesStart.getDay() // 0=Sun
    const daysToMon = (seriesDow === 0 ? -6 : 1 - seriesDow)
    let weekStart = new Date(seriesStart.getTime() + daysToMon * MS_PER_DAY)

    while (weekStart <= effectiveEnd && results.length < maxCount) {
      for (const dow of sortedTargetDays) {
        // dow=0 is Sunday: in ISO week it trails the week; shift to slot 7
        const offset = dow === 0 ? 6 : dow - 1
        const candidate = new Date(weekStart.getTime() + offset * MS_PER_DAY)

        if (candidate <= seriesStart) continue // Skip root's own date and earlier
        if (candidate > effectiveEnd) break
        if (candidate < from) continue

        results.push(toISODate(candidate))
        if (results.length >= maxCount) break
      }
      weekStart = new Date(weekStart.getTime() + intervalDays * MS_PER_DAY)
    }
  } else if (rule.freq === 'monthly') {
    const dayOfMonth = seriesStart.getDate()
    // Start one month after the series root
    let cur = addMonths(seriesStart, 1)
    cur.setDate(Math.min(dayOfMonth, new Date(cur.getFullYear(), cur.getMonth() + 1, 0).getDate()))

    while (cur <= effectiveEnd && results.length < maxCount) {
      if (cur >= from) results.push(toISODate(cur))
      const nextMonth = addMonths(cur, 1)
      const daysInMonth = new Date(nextMonth.getFullYear(), nextMonth.getMonth() + 1, 0).getDate()
      nextMonth.setDate(Math.min(dayOfMonth, daysInMonth))
      cur = nextMonth
    }
  }

  return results
}

// ─── DB operations ────────────────────────────────────────────────────────────

type CalendarEventRow = {
  id: number
  title: string
  start_at: string
  end_at: string
  attendees: string
  linked_note_id: string | null
  recurrence_rule: string | null
  recurrence_series_id: number | null
  recurrence_instance_date: string | null
}

/**
 * Generate occurrence rows for a series root up to `windowMonths` ahead.
 *
 * Safe to call multiple times — existing occurrence rows (identified by
 * series_id + instance_date) are never re-inserted (INSERT OR IGNORE).
 * Occurrences with a linked_note_id are never deleted or overwritten.
 */
export function generateOccurrences(
  db: Database.Database,
  rootId: number,
  windowMonths = RECURRENCE_WINDOW_MONTHS,
): void {
  const root = db
    .prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(rootId) as CalendarEventRow | undefined

  if (!root || !root.recurrence_rule) return

  const rule = parseRecurrenceRule(root.recurrence_rule)
  if (!rule) return

  const today = new Date()
  const fromDate = toISODate(new Date(root.start_at.split('T')[0])) // from series start
  const toDate = toISODate(addMonths(today, windowMonths))

  const dates = expandDates(root.start_at, rule, fromDate, toDate)
  if (dates.length === 0) return

  // Duration of the root event in ms (to compute end_at for each occurrence)
  const rootStartDate = new Date(root.start_at)
  const rootEndDate = new Date(root.end_at)
  const durationMs = rootEndDate.getTime() - rootStartDate.getTime()

  const insert = db.prepare(`
    INSERT OR IGNORE INTO calendar_events
      (title, start_at, end_at, attendees, recurrence_series_id, recurrence_instance_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  db.transaction(() => {
    for (const date of dates) {
      const occStart = occurrenceStart(date, rootStartDate)
      const occEnd = new Date(occStart.getTime() + durationMs)
      insert.run(root.title, occStart.toISOString(), occEnd.toISOString(), root.attendees, rootId, date)
    }
  })()
}

/**
 * Apply changes to a recurring event with the given scope.
 *
 * 'this'   — Update only this occurrence and detach it from the series
 *            (clears recurrence_series_id and recurrence_instance_date).
 *
 * 'future' — Update this occurrence and all future untouched occurrences
 *            (those with start_at >= this.start_at and linked_note_id IS NULL).
 *            The current occurrence is also updated (even if it has a note).
 *
 * 'all'    — Update the series root and all future untouched occurrences.
 *            If recurrence_rule is part of the changes, regenerates occurrences.
 *
 * `changes` is a plain object of column → value pairs drawn from CalendarEventRow
 * (title, start_at, end_at, attendees, recurrence_rule, linked_note_id).
 * Columns that are not safe to bulk-update (id, recurrence_series_id,
 * recurrence_instance_date) are stripped out automatically.
 */
export function applyRecurrenceUpdate(
  db: Database.Database,
  occurrenceId: number,
  changes: Partial<Omit<CalendarEventRow, 'id' | 'recurrence_series_id' | 'recurrence_instance_date'>>,
  scope: UpdateScope,
): void {
  const occurrence = db
    .prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(occurrenceId) as CalendarEventRow | undefined

  if (!occurrence) return

  // Strip columns that must never be bulk-updated
  const FORBIDDEN = new Set(['id', 'recurrence_series_id', 'recurrence_instance_date'])
  const safeChanges = Object.fromEntries(
    Object.entries(changes).filter(([k]) => !FORBIDDEN.has(k)),
  )

  if (Object.keys(safeChanges).length === 0) return

  const sets = Object.keys(safeChanges).map((k) => `${k} = ?`)
  const vals = Object.values(safeChanges)

  if (scope === 'this') {
    db.transaction(() => {
      db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals, occurrenceId)
      // Detach from series so this becomes a standalone event
      if (occurrence.recurrence_series_id !== null) {
        db.prepare(
          `UPDATE calendar_events
           SET recurrence_series_id = NULL, recurrence_instance_date = NULL
           WHERE id = ?`,
        ).run(occurrenceId)
      }
    })()
    return
  }

  if (scope === 'future') {
    const seriesId = occurrence.recurrence_series_id ?? occurrenceId
    db.transaction(() => {
      // Update this occurrence
      db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals, occurrenceId)
      // Update future untouched occurrences (no note linked)
      db.prepare(
        `UPDATE calendar_events
         SET ${sets.join(', ')}
         WHERE recurrence_series_id = ?
           AND start_at > ?
           AND linked_note_id IS NULL`,
      ).run(...vals, seriesId, occurrence.start_at)
    })()
    return
  }

  if (scope === 'all') {
    const seriesId = occurrence.recurrence_series_id ?? occurrenceId
    const ruleChanged = 'recurrence_rule' in safeChanges

    db.transaction(() => {
      // Update root
      db.prepare(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals, seriesId)
      // Update all untouched occurrences
      db.prepare(
        `UPDATE calendar_events
         SET ${sets.join(', ')}
         WHERE recurrence_series_id = ?
           AND linked_note_id IS NULL`,
      ).run(...vals, seriesId)
    })()

    // If the recurrence rule changed, delete untouched future occurrences and regenerate
    if (ruleChanged) {
      db.prepare(
        `DELETE FROM calendar_events
         WHERE recurrence_series_id = ?
           AND start_at > strftime('%Y-%m-%dT%H:%M:%S', 'now')
           AND linked_note_id IS NULL`,
      ).run(seriesId)
      generateOccurrences(db, seriesId)
    }
  }
}

/**
 * Delete a recurring event with the given scope.
 *
 * 'this'   — Delete only this occurrence.
 *
 * 'future' — Delete this occurrence and all future occurrences of the same
 *            series (regardless of whether they have a linked note). Also
 *            updates the root's `until` date to cap the series.
 *
 * 'all'    — Delete the series root and every occurrence of the series.
 */
export function applyRecurrenceDelete(
  db: Database.Database,
  occurrenceId: number,
  scope: DeleteScope,
): void {
  const occurrence = db
    .prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(occurrenceId) as CalendarEventRow | undefined

  if (!occurrence) return

  if (scope === 'this') {
    db.prepare('DELETE FROM calendar_events WHERE id = ?').run(occurrenceId)
    return
  }

  if (scope === 'future') {
    const seriesId = occurrence.recurrence_series_id ?? occurrenceId
    db.transaction(() => {
      // Delete this occurrence and all future ones
      db.prepare(
        `DELETE FROM calendar_events
         WHERE (id = ? OR recurrence_series_id = ?)
           AND start_at >= ?`,
      ).run(occurrenceId, seriesId, occurrence.start_at)

      // Cap the root's rule with an `until` date = day before this occurrence
      const root = db
        .prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
        .get(seriesId) as { recurrence_rule: string | null } | undefined

      if (root?.recurrence_rule) {
        const rule = parseRecurrenceRule(root.recurrence_rule)
        if (rule) {
          const instanceDate = occurrence.recurrence_instance_date ?? occurrence.start_at.split('T')[0]
          const capDate = toISODate(new Date(parseISODate(instanceDate).getTime() - 24 * 60 * 60 * 1000))
          rule.until = capDate
          delete rule.count
          db.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?').run(
            JSON.stringify(rule),
            seriesId,
          )
        }
      }
    })()
    return
  }

  if (scope === 'all') {
    const seriesId = occurrence.recurrence_series_id ?? occurrenceId
    db.transaction(() => {
      // Delete all occurrences first, then the root
      db.prepare('DELETE FROM calendar_events WHERE recurrence_series_id = ?').run(seriesId)
      db.prepare('DELETE FROM calendar_events WHERE id = ?').run(seriesId)
    })()
  }
}

// ─── Series note history ──────────────────────────────────────────────────────

export interface SeriesOccurrence {
  event_id: number
  event_date: string       // YYYY-MM-DD
  note_id: string | null
  note_title: string | null
  excerpt: string | null   // First 120 chars of body_plain
}

/**
 * Return the most recent past occurrences of a series (up to 20), newest first.
 * Includes the series root itself if its start_at is in the past.
 * Used by the NoteEditor "Series History" panel.
 */
export function getSeriesNotes(db: Database.Database, seriesId: number): SeriesOccurrence[] {
  return db
    .prepare(
      `SELECT
         ce.id                               AS event_id,
         substr(ce.start_at, 1, 10)          AS event_date,
         n.id                                AS note_id,
         n.title                             AS note_title,
         substr(n.body_plain, 1, 120)        AS excerpt
       FROM calendar_events ce
       LEFT JOIN notes n ON ce.linked_note_id = n.id AND n.archived_at IS NULL
       WHERE (ce.id = ? OR ce.recurrence_series_id = ?)
         AND ce.start_at < strftime('%Y-%m-%dT%H:%M:%S', 'now')
       ORDER BY ce.start_at DESC
       LIMIT 20`,
    )
    .all(seriesId, seriesId) as SeriesOccurrence[]
}

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { dayIndexToAbbr }
