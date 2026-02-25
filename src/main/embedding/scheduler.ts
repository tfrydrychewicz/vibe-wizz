/**
 * Nightly cluster batch scheduler.
 *
 * Called once at app startup (from main/index.ts). Checks whether a
 * cluster rebuild is due (> 23 hours since last run) and if so runs
 * the L3 clustering pipeline in the background.
 *
 * Guards:
 *  - sqlite-vec must be loaded
 *  - Both openai_api_key and anthropic_api_key must be configured
 *  - At least 5 L2 note summaries must exist
 *  - Skipped if a run is already in progress (singleton mutex)
 *  - Skipped if last run was < 23h ago
 */

import { getDatabase, isVecLoaded } from '../db/index'
import { runL3Clustering } from './clusterBuilder'
import { pushToRenderer } from '../push'

const MIN_INTERVAL_MS = 23 * 60 * 60 * 1000 // 23 hours
const MIN_L2_COUNT = 5

let _isRunning = false

/** Fire-and-forget entry point. Call after initDatabase() at app startup. */
export function scheduleNightlyClusterBatch(): void {
  runBatchIfDue().catch((err) => {
    console.error('[Cluster] Scheduler error:', err)
  })
}

async function runBatchIfDue(): Promise<void> {
  if (_isRunning) return
  if (!isVecLoaded()) return

  const db = getDatabase()

  // Read API keys
  const openaiKey =
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('openai_api_key') as { value: string } | undefined)
      ?.value ?? ''
  const anthropicKey =
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic_api_key') as { value: string } | undefined)
      ?.value ?? ''

  if (!openaiKey || !anthropicKey) {
    console.log('[Cluster] Batch skipped — API keys not configured')
    return
  }

  // Check last run timestamp
  const lastRunRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('cluster_last_run') as { value: string } | undefined

  if (lastRunRow?.value) {
    const elapsed = Date.now() - new Date(lastRunRow.value).getTime()
    if (elapsed < MIN_INTERVAL_MS) {
      console.log('[Cluster] Batch skipped — ran within last 23h')
      return
    }
  }

  // Check minimum L2 note count
  const { cnt } = db
    .prepare('SELECT COUNT(*) AS cnt FROM note_chunks WHERE layer = 2')
    .get() as { cnt: number }

  if (cnt < MIN_L2_COUNT) {
    console.log(`[Cluster] Batch skipped — only ${cnt} L2 summaries (need ${MIN_L2_COUNT})`)
    return
  }

  _isRunning = true
  console.log('[Cluster] Starting nightly batch...')

  try {
    await runL3Clustering(db, openaiKey, anthropicKey)

    // Persist last-run timestamp
    db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run('cluster_last_run', new Date().toISOString())

    console.log('[Cluster] Nightly batch complete')
    pushToRenderer('cluster:complete', {})
  } catch (err) {
    console.error('[Cluster] Nightly batch failed:', err)
  } finally {
    _isRunning = false
  }
}
