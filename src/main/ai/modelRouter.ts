/**
 * Model router — the single entry point for all AI feature calls.
 *
 * resolveChain() reads the user-configured model chain from the DB for a
 * given feature slot, injects the API key for each model's provider, and
 * returns a list of ResolvedModel objects ready for use.
 *
 * callWithFallback() wraps any async operation with automatic fallback:
 * it tries each model in the chain in order, and only re-throws when every
 * model in the chain has failed.
 *
 * All AI feature files (summarizer.ts, ner.ts, chat.ts, …) call these
 * two functions instead of hard-coding model IDs and API keys.
 */

import Database from 'better-sqlite3'
import { getAdapter } from './registry'
import { DEFAULT_CHAINS, FEATURE_SLOTS, type FeatureSlotId } from './featureSlots'
import type { ProviderAdapter } from './providers/types'

// ── Resolved model ─────────────────────────────────────────────────────────

export interface ResolvedModel {
  modelId: string
  providerId: string
  apiKey: string
  adapter: ProviderAdapter
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface FeatureModelRow {
  model_id: string
  provider_id: string
  api_key: string
  enabled: number // 1 | 0
}

// ── resolveChain ──────────────────────────────────────────────────────────────

/**
 * Resolve the ordered model chain for a feature slot.
 *
 * Resolution order:
 * 1. DB rows from ai_feature_models, joined to ai_models + ai_providers,
 *    ordered by position, filtered to enabled models with non-empty API keys.
 * 2. If the DB chain is empty (unconfigured slot or all models disabled),
 *    fall back to DEFAULT_CHAINS — which replicate the previously hardcoded assignments.
 *
 * Returns an empty array only if there are no usable models at all
 * (no keys configured for any provider in the default chain).
 */
export function resolveChain(featureSlot: FeatureSlotId, db: Database.Database): ResolvedModel[] {
  const rows = db
    .prepare(
      `SELECT
         fm.model_id,
         m.provider_id,
         p.api_key,
         m.enabled
       FROM ai_feature_models fm
       JOIN ai_models    m ON m.id = fm.model_id
       JOIN ai_providers p ON p.id = m.provider_id
       WHERE fm.feature_slot = ?
         AND m.enabled = 1
         AND p.enabled = 1
         AND p.api_key != ''
       ORDER BY fm.position ASC`,
    )
    .all(featureSlot) as FeatureModelRow[]

  const fromDb = rows.flatMap((row) => {
    try {
      const adapter = getAdapter(row.provider_id)
      return [{ modelId: row.model_id, providerId: row.provider_id, apiKey: row.api_key, adapter }]
    } catch {
      return []
    }
  })

  if (fromDb.length > 0) return fromDb

  // Fallback 1: resolve DEFAULT_CHAINS against whatever providers are configured in DB
  const fromDefault = resolveDefaultChain(featureSlot, db)
  if (fromDefault.length > 0) return fromDefault

  // Fallback 2: auto-discover any enabled model with the matching capability.
  // Covers the case where the user has enabled an image (or other) model that
  // isn't in the hardcoded DEFAULT_CHAINS list and hasn't explicitly assigned it.
  return discoverByCapability(featureSlot, db)
}

function resolveDefaultChain(featureSlot: FeatureSlotId, db: Database.Database): ResolvedModel[] {
  const defaultModelIds = DEFAULT_CHAINS[featureSlot] ?? []
  const results: ResolvedModel[] = []

  for (const modelId of defaultModelIds) {
    const row = db
      .prepare(
        `SELECT m.provider_id, p.api_key
         FROM ai_models    m
         JOIN ai_providers p ON p.id = m.provider_id
         WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1 AND p.api_key != ''`,
      )
      .get(modelId) as { provider_id: string; api_key: string } | undefined

    if (row) {
      try {
        const adapter = getAdapter(row.provider_id)
        results.push({ modelId, providerId: row.provider_id, apiKey: row.api_key, adapter })
      } catch {
        // Unknown provider — skip
      }
    }
  }

  return results
}

/**
 * Last-resort fallback: find any enabled model whose capabilities column
 * contains the required capability for the given slot. This ensures that
 * e.g. an enabled Gemini Imagen model is automatically picked up for the
 * image_generation slot even when the user hasn't explicitly assigned it
 * and the hardcoded DEFAULT_CHAINS entry (gpt-image-1) isn't available.
 */
function discoverByCapability(
  featureSlot: FeatureSlotId,
  db: Database.Database,
): ResolvedModel[] {
  const slot = FEATURE_SLOTS.find((s) => s.id === featureSlot)
  if (!slot) return []

  const rows = db
    .prepare(
      `SELECT m.id AS model_id, m.provider_id, p.api_key
       FROM ai_models m
       JOIN ai_providers p ON p.id = m.provider_id
       WHERE m.enabled = 1
         AND p.enabled = 1
         AND p.api_key != ''
         AND m.capabilities LIKE ?
       ORDER BY m.id ASC`,
    )
    .all(`%${slot.capability}%`) as { model_id: string; provider_id: string; api_key: string }[]

  const results: ResolvedModel[] = []
  for (const row of rows) {
    try {
      const adapter = getAdapter(row.provider_id)
      results.push({
        modelId: row.model_id,
        providerId: row.provider_id,
        apiKey: row.api_key,
        adapter,
      })
    } catch {
      // Unknown provider — skip
    }
  }
  return results
}

// ── callWithFallback ──────────────────────────────────────────────────────────

/**
 * Execute fn(model) using each model in the resolved chain.
 *
 * - On success, returns the result immediately.
 * - On failure, logs the error and tries the next model.
 * - If all models fail, throws an AggregateError with all collected errors.
 * - If the chain is empty (no providers configured), throws a descriptive error.
 */
export async function callWithFallback<T>(
  featureSlot: FeatureSlotId,
  db: Database.Database,
  fn: (model: ResolvedModel) => Promise<T>,
  overrideModelId?: string,
  onFallback?: (from: string, to: string) => void,
): Promise<T> {
  const chain = resolveChain(featureSlot, db)

  // If a specific model is requested, ensure it is at the front of the chain.
  // If it is already present, move it; if not (e.g. the user selects a model that
  // isn't part of the configured feature chain), resolve it from the DB and prepend it.
  if (overrideModelId) {
    const existingIdx = chain.findIndex((m) => m.modelId === overrideModelId)
    if (existingIdx > 0) {
      chain.unshift(...chain.splice(existingIdx, 1))
    } else if (existingIdx === -1) {
      const row = db
        .prepare(
          `SELECT m.provider_id, p.api_key
           FROM ai_models    m
           JOIN ai_providers p ON p.id = m.provider_id
           WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1 AND p.api_key != ''`,
        )
        .get(overrideModelId) as { provider_id: string; api_key: string } | undefined

      if (row) {
        try {
          const adapter = getAdapter(row.provider_id)
          chain.unshift({ modelId: overrideModelId, providerId: row.provider_id, apiKey: row.api_key, adapter })
        } catch {
          // Unknown provider — fall through to existing chain
        }
      }
    }
  }

  if (chain.length === 0) {
    throw new Error(
      `No AI models configured for "${featureSlot}". ` +
        'Open Settings → AI Providers to add an API key.',
    )
  }

  const errors: unknown[] = []

  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]
    try {
      return await fn(model)
    } catch (err) {
      const label = `${model.providerId}/${model.modelId}`
      console.warn(`[modelRouter] ${featureSlot}: failed on ${label}:`, err)
      errors.push(err)
      // Notify caller of first fallback transition so it can surface a warning
      if (i === 0 && i + 1 < chain.length && onFallback) {
        onFallback(model.modelId, chain[i + 1].modelId)
      }
    }
  }

  throw new AggregateError(
    errors,
    `All models in the "${featureSlot}" chain failed (tried ${chain.map((m) => m.modelId).join(' → ')}).`,
  )
}
