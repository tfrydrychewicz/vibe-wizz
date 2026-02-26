/**
 * Background scheduler for calendar source sync.
 *
 * startCalendarSyncScheduler() is called once at app startup (from main/index.ts).
 * It fires an initial check immediately, then checks every 60 seconds.
 * Each source is synced independently based on its own sync_interval_minutes.
 *
 * Guards per source:
 *  - enabled = 1 (disabled sources are skipped)
 *  - not currently syncing (per-source mutex via _running Set)
 *  - enough time has elapsed since last_sync_at
 */

import { getDatabase } from '../../db/index'
import { pushToRenderer } from '../../push'
import type { CalendarSource } from './provider'
import { syncSource } from './engine'

const TICK_INTERVAL_MS = 60_000 // check every minute

/** Source IDs currently being synced — prevents overlapping runs per source. */
const _running = new Set<string>()

let _started = false

/**
 * Start the periodic sync ticker.
 * Safe to call multiple times — only the first call takes effect.
 */
export function startCalendarSyncScheduler(): void {
  if (_started) return
  _started = true

  // Run once at startup, then on the interval
  syncDue()
  setInterval(syncDue, TICK_INTERVAL_MS)
}

function syncDue(): void {
  const db = getDatabase()

  const sources = db
    .prepare('SELECT * FROM calendar_sources WHERE enabled = 1')
    .all() as CalendarSource[]

  for (const source of sources) {
    if (_running.has(source.id)) continue

    const intervalMs = source.sync_interval_minutes * 60_000
    const lastSync = source.last_sync_at ? new Date(source.last_sync_at).getTime() : 0
    if (Date.now() - lastSync < intervalMs) continue

    _running.add(source.id)

    syncSource(db, source)
      .then((count) => {
        pushToRenderer('calendar-sync:complete', { sourceId: source.id, count })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`[CalSync] source "${source.name}" (${source.id}) failed:`, err)
        pushToRenderer('calendar-sync:error', { sourceId: source.id, message })
      })
      .finally(() => {
        _running.delete(source.id)
      })
  }
}

/**
 * Trigger an immediate sync for one source, bypassing the interval check.
 * Used by the `calendar-sources:sync-now` IPC handler.
 *
 * @returns number of events upserted
 * @throws  if the source is already syncing or the provider fetch fails
 */
export async function syncSourceNow(sourceId: string): Promise<number> {
  if (_running.has(sourceId)) {
    throw new Error('Sync already in progress for this source.')
  }

  const db = getDatabase()
  const source = db
    .prepare('SELECT * FROM calendar_sources WHERE id = ?')
    .get(sourceId) as CalendarSource | undefined

  if (!source) {
    throw new Error(`Calendar source not found: ${sourceId}`)
  }

  _running.add(sourceId)
  try {
    const count = await syncSource(db, source)
    pushToRenderer('calendar-sync:complete', { sourceId, count })
    return count
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    pushToRenderer('calendar-sync:error', { sourceId, message })
    throw err
  } finally {
    _running.delete(sourceId)
  }
}
