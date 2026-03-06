/**
 * Entity Review Scheduler.
 *
 * Called once at app startup (from main/index.ts). Runs an initial check
 * immediately, then polls every 30 minutes. For each entity type that has
 * review_enabled = 1, it checks whether a review is due and if so generates
 * one for every non-trashed entity of that type.
 *
 * Guards:
 *  - Per-type mutex via _running Set (prevents overlapping runs for the same type)
 *  - Only one scheduler started (idempotent via _started flag)
 *  - Review considered due only after the configured review_time local hour
 *  - Day-of-week check enforced for weekly and biweekly frequencies
 *  - Minimum gap enforced for biweekly (12 days) and monthly (25 days) to
 *    prevent double-generation within the same intended window
 */

import Database from 'better-sqlite3'
import { getDatabase } from '../db/index'
import { pushToRenderer } from '../push'
import {
  generateEntityReview,
  type EntityTypeWithReview,
  type EntityReview,
} from './reviewGenerator'

// ── Constants ──────────────────────────────────────────────────────────────────

const TICK_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes

// ── State ─────────────────────────────────────────────────────────────────────

/** Type IDs currently being processed — prevents overlapping runs per type. */
const _running = new Set<string>()

let _started = false

// ── Helpers ───────────────────────────────────────────────────────────────────

function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/**
 * Pure function — determines whether a review should be generated right now
 * for a given entity type, given the most recent existing review's period_end.
 *
 * A review is due when all of the following hold:
 *  1. review_enabled = 1 and review_frequency is set
 *  2. Current local time >= review_time (HH:MM)
 *  3. No review has already been generated for the current window
 *     (period_end = yesterday, since getPeriodWindow always ends yesterday)
 *  4. For weekly / biweekly: today is the configured review_day
 *  5. For biweekly: at least 12 days have passed since the last review's period_end
 *  6. For monthly:  at least 25 days have passed since the last review's period_end
 */
export function isReviewDue(
  type: EntityTypeWithReview,
  latestPeriodEnd: string | null,
): boolean {
  if (!type.review_enabled || !type.review_frequency) return false

  const now = new Date()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const yesterdayStr = localDateString(yesterday)

  // Already generated for the current window
  if (latestPeriodEnd === yesterdayStr) return false

  // Time-of-day gate: don't generate before the configured local time
  const [hStr = '7', mStr = '0'] = type.review_time.split(':')
  const reviewMinuteOfDay = parseInt(hStr, 10) * 60 + parseInt(mStr, 10)
  const nowMinuteOfDay = now.getHours() * 60 + now.getMinutes()
  if (nowMinuteOfDay < reviewMinuteOfDay) return false

  const freq = type.review_frequency

  // Day-of-week constraint for weekly and biweekly
  if (freq === 'weekly' || freq === 'biweekly') {
    const requiredDay = type.review_day ?? 'mon'
    const todayDayName = DAY_NAMES[now.getDay()]
    if (todayDayName !== requiredDay) return false
  }

  // Minimum gap enforcement to prevent double-generation within a window
  if (latestPeriodEnd) {
    const msPerDay = 86_400_000
    const daysSinceLast = Math.floor(
      (new Date(`${yesterdayStr}T12:00:00`).getTime() -
        new Date(`${latestPeriodEnd}T12:00:00`).getTime()) /
        msPerDay,
    )
    if (freq === 'biweekly' && daysSinceLast < 12) return false
    if (freq === 'monthly'  && daysSinceLast < 25) return false
  }

  return true
}

// ── Core logic ────────────────────────────────────────────────────────────────

async function checkAndGenerateReviews(db: Database.Database): Promise<void> {
  const enabledTypes = db
    .prepare(
      `SELECT id, name, icon, schema, color,
              review_enabled, review_frequency, review_day, review_time
       FROM entity_types
       WHERE review_enabled = 1 AND review_frequency IS NOT NULL`,
    )
    .all() as EntityTypeWithReview[]

  for (const type of enabledTypes) {
    if (_running.has(type.id)) continue
    _running.add(type.id)

    processType(db, type).catch((err: unknown) => {
      console.error(`[ReviewScheduler] type "${type.name}" failed:`, err)
    }).finally(() => {
      _running.delete(type.id)
    })
  }
}

async function processType(db: Database.Database, type: EntityTypeWithReview): Promise<void> {
  const entities = db
    .prepare(
      `SELECT id, name, type_id, fields FROM entities
       WHERE type_id = ? AND trashed_at IS NULL
       ORDER BY name ASC`,
    )
    .all(type.id) as { id: string; name: string; type_id: string; fields: string }[]

  if (entities.length === 0) return

  let generated = 0

  for (const entity of entities) {
    // Get the most recent review's period_end for this specific entity
    const latestRow = db
      .prepare(
        `SELECT period_end FROM entity_reviews
         WHERE entity_id = ?
         ORDER BY generated_at DESC
         LIMIT 1`,
      )
      .get(entity.id) as { period_end: string } | undefined

    const latestPeriodEnd = latestRow?.period_end ?? null

    if (!isReviewDue(type, latestPeriodEnd)) continue

    try {
      const result = await generateEntityReview(db, entity, type)

      if ('error' in result) {
        // No model configured — log once and stop processing remaining entities
        console.warn(`[ReviewScheduler] skipping entity "${entity.name}": ${result.error}`)
        break
      }

      const review = result as EntityReview
      pushToRenderer('entity-review:complete', { entityId: entity.id, reviewId: review.id })
      generated++

      console.log(
        `[ReviewScheduler] generated review for "${entity.name}" ` +
        `(${review.period_start} → ${review.period_end})`,
      )
    } catch (err) {
      console.error(`[ReviewScheduler] failed for entity "${entity.name}":`, err)
      // Continue to next entity — don't let one failure block the rest
    }
  }

  if (generated > 0) {
    console.log(`[ReviewScheduler] ${type.name}: generated ${generated} review(s)`)
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Start the periodic entity review scheduler.
 * Safe to call multiple times — only the first call takes effect.
 */
export function scheduleEntityReviews(): void {
  if (_started) return
  _started = true

  // Run immediately on startup, then every 30 minutes
  const run = (): void => {
    const db = getDatabase()
    checkAndGenerateReviews(db).catch((err: unknown) => {
      console.error('[ReviewScheduler] tick error:', err)
    })
  }

  run()
  setInterval(run, TICK_INTERVAL_MS)
}
