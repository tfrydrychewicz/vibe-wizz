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
  type ReviewFilter,
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
 *  2. No review has already been generated for the current window
 *     (period_end = yesterday, since getPeriodWindow always ends yesterday)
 *  3. The scheduled moment has passed:
 *     - daily: current local time >= review_time
 *     - weekly/biweekly: today is on or after review_day (if on the day, time >= review_time)
 *       — if the app was not run on the scheduled day, the next run will catch up
 *     - monthly: time >= review_time and gap check
 *  4. For biweekly: at least 12 days have passed since the last review's period_end
 *  5. For monthly:  at least 25 days have passed since the last review's period_end
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

  const [hStr = '7', mStr = '0'] = type.review_time.split(':')
  const reviewMinuteOfDay = parseInt(hStr, 10) * 60 + parseInt(mStr, 10)
  const nowMinuteOfDay = now.getHours() * 60 + now.getMinutes()
  const freq = type.review_frequency

  // Weekly / biweekly: scheduled day must have passed (or we're on it and past time).
  // If the app was not run on the scheduled day, the next run will catch up.
  if (freq === 'weekly' || freq === 'biweekly') {
    const requiredDay = type.review_day ?? 'mon'
    const todayDayName = DAY_NAMES[now.getDay()]
    const todayIndex = DAY_NAMES.indexOf(todayDayName)
    const requiredIndex = DAY_NAMES.indexOf(requiredDay)

    if (todayIndex < requiredIndex) return false // scheduled day hasn't come yet this week
    if (todayIndex > requiredIndex) {
      // we're past the scheduled day — run catch-up (skip time-of-day gate)
    } else {
      // todayIndex === requiredIndex: due only if past the configured time
      if (nowMinuteOfDay < reviewMinuteOfDay) return false
    }
  } else {
    // daily / monthly: enforce time-of-day gate
    if (nowMinuteOfDay < reviewMinuteOfDay) return false
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

/**
 * Returns true if the entity's fields satisfy all configured review filters.
 * All filters are ANDed; an empty filter list always returns true.
 *
 * Field values are coerced to strings for comparison:
 *   - Strings: used directly
 *   - Entity refs ({ id, name }): matched against the `name` string
 *   - Everything else: JSON-stringified
 */
function entityMatchesFilters(
  entity: { fields: string },
  filters: ReviewFilter[],
): boolean {
  if (filters.length === 0) return true

  let fields: Record<string, unknown> = {}
  try { fields = JSON.parse(entity.fields) as Record<string, unknown> } catch { return true }

  for (const f of filters) {
    const raw = fields[f.field]
    const val: string =
      raw === null || raw === undefined
        ? ''
        : typeof raw === 'string'
          ? raw
          : typeof raw === 'object' && raw !== null && 'name' in raw
            ? String((raw as Record<string, unknown>).name ?? '')
            : JSON.stringify(raw)

    const valLower = val.toLowerCase()
    const filterLower = (f.value ?? '').toLowerCase()

    switch (f.op) {
      case 'eq':          if (valLower !== filterLower) return false; break
      case 'neq':         if (valLower === filterLower) return false; break
      case 'contains':    if (!valLower.includes(filterLower)) return false; break
      case 'not_contains':if (valLower.includes(filterLower)) return false; break
      case 'is_set':      if (!val.trim()) return false; break
      case 'is_empty':    if (val.trim()) return false; break
    }
  }
  return true
}

async function processType(db: Database.Database, type: EntityTypeWithReview): Promise<void> {
  // Parse and apply entity-level review filters
  let filters: ReviewFilter[] = []
  if (type.review_filters) {
    try { filters = JSON.parse(type.review_filters) as ReviewFilter[] } catch { /* ignore */ }
  }

  const allEntities = db
    .prepare(
      `SELECT id, name, type_id, fields FROM entities
       WHERE type_id = ? AND trashed_at IS NULL
       ORDER BY name ASC`,
    )
    .all(type.id) as { id: string; name: string; type_id: string; fields: string }[]

  const entities = allEntities.filter((e) => entityMatchesFilters(e, filters))

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
