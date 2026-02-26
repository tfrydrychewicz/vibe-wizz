/**
 * Sync engine — fetches events from one CalendarSource and upserts them into
 * the local calendar_events table.
 *
 * Design decisions:
 *  - external_id is the stable key: "{sourceId}:{providerEventId}"
 *  - ON CONFLICT(external_id) DO UPDATE overwrites remote-owned fields but
 *    intentionally leaves linked_note_id and transcript_note_id untouched
 *    (those are user annotations that survive re-syncs)
 *  - Stale events (present in DB but absent from latest fetch) are deleted,
 *    EXCEPT rows that have a linked_note_id — the user has annotated them,
 *    so we preserve the row but clear its external_id to detach it from sync
 *  - The fetch window is 7 days in the past → 90 days ahead; events outside
 *    this window are left as-is (not purged) to avoid thrashing history
 */

import type Database from 'better-sqlite3'
import type { CalendarSource } from './provider'
import { getProvider } from './registry'

const DAYS_BACK = 7
const DAYS_AHEAD = 90

function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

function subDays(date: Date, days: number): Date {
  return addDays(date, -days)
}

/**
 * Sync a single CalendarSource: fetch remote events, upsert into DB,
 * purge stale rows, update last_sync_at.
 *
 * @returns number of events upserted (new + updated)
 * @throws  if the provider fetch fails — caller is responsible for logging
 */
export async function syncSource(db: Database.Database, source: CalendarSource): Promise<number> {
  const provider = getProvider(source.provider_id)
  if (!provider) {
    throw new Error(`[CalSync] Unknown provider: ${source.provider_id}`)
  }

  const config = JSON.parse(source.config) as Record<string, string>
  const now = new Date()
  const from = subDays(now, DAYS_BACK)
  const to = addDays(now, DAYS_AHEAD)

  const events = await provider.fetchEvents(config, from, to)

  // ── Upsert ────────────────────────────────────────────────────────────────
  // We touch only the remote-owned columns. linked_note_id and
  // transcript_note_id are excluded from the UPDATE so user annotations persist.
  const upsert = db.prepare(`
    INSERT INTO calendar_events
      (external_id, source_id, title, start_at, end_at, attendees, recurrence_rule, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      title           = excluded.title,
      start_at        = excluded.start_at,
      end_at          = excluded.end_at,
      attendees       = excluded.attendees,
      recurrence_rule = excluded.recurrence_rule,
      synced_at       = excluded.synced_at
  `)

  const syncedAt = now.toISOString()
  const upsertMany = db.transaction(
    (
      rows: {
        externalId: string
        title: string
        startAt: string
        endAt: string
        attendees: string
        recurrenceRule: string | null
      }[]
    ) => {
      for (const row of rows) {
        upsert.run(
          row.externalId,
          source.id,
          row.title,
          row.startAt,
          row.endAt,
          row.attendees,
          row.recurrenceRule,
          syncedAt
        )
      }
    }
  )

  const rows = events.map((ev) => ({
    externalId: `${source.id}:${ev.externalId}`,
    title: ev.title,
    startAt: ev.startAt,
    endAt: ev.endAt,
    attendees: JSON.stringify(ev.attendees),
    recurrenceRule: ev.recurrenceRule ?? null,
  }))

  upsertMany(rows)

  // ── Stale-event purge ─────────────────────────────────────────────────────
  // Only consider events within the fetch window — events outside it are left
  // alone to preserve historical data.
  const freshIds = new Set(rows.map((r) => r.externalId))

  const windowEvents = db
    .prepare(
      `SELECT id, external_id, linked_note_id
       FROM calendar_events
       WHERE source_id = ?
         AND start_at >= ?
         AND start_at <= ?`
    )
    .all(source.id, from.toISOString(), to.toISOString()) as {
    id: number
    external_id: string
    linked_note_id: string | null
  }[]

  const toDelete: number[] = []
  const toDetach: number[] = [] // has linked note — detach from sync, keep row

  for (const row of windowEvents) {
    if (freshIds.has(row.external_id)) continue // still present remotely

    if (row.linked_note_id) {
      // User has linked a note — preserve the event but sever the sync link
      // so it won't be touched by future syncs
      toDetach.push(row.id)
    } else {
      toDelete.push(row.id)
    }
  }

  if (toDetach.length > 0) {
    const detach = db.prepare(
      'UPDATE calendar_events SET external_id = NULL, source_id = NULL WHERE id = ?'
    )
    db.transaction(() => {
      for (const id of toDetach) detach.run(id)
    })()
  }

  if (toDelete.length > 0) {
    const del = db.prepare('DELETE FROM calendar_events WHERE id = ?')
    db.transaction(() => {
      for (const id of toDelete) del.run(id)
    })()
  }

  // ── Update last_sync_at ───────────────────────────────────────────────────
  db.prepare('UPDATE calendar_sources SET last_sync_at = ? WHERE id = ?').run(
    syncedAt,
    source.id
  )

  console.log(
    `[CalSync] source "${source.name}" synced: ${events.length} events, ` +
      `${toDelete.length} purged, ${toDetach.length} detached`
  )

  return events.length
}
