/**
 * Provider registry.
 *
 * Maps provider IDs to their adapters and curated model lists.
 * This is the single place where new providers are registered.
 */

import { anthropicAdapter, ANTHROPIC_POPULAR_MODELS } from './providers/anthropic'
import { openaiAdapter, OPENAI_POPULAR_MODELS } from './providers/openai'
import { geminiAdapter, GEMINI_POPULAR_MODELS } from './providers/gemini'
import type { ProviderAdapter, ModelDef } from './providers/types'

// ── Provider definition ───────────────────────────────────────────────────────

export interface ProviderDef {
  id: string
  label: string
  /** Models to show in Settings when no live /models fetch has been run yet */
  popularModels: ModelDef[]
  adapter: ProviderAdapter
}

export const PROVIDER_DEFS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    popularModels: ANTHROPIC_POPULAR_MODELS,
    adapter: anthropicAdapter,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    popularModels: OPENAI_POPULAR_MODELS,
    adapter: openaiAdapter,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    popularModels: GEMINI_POPULAR_MODELS,
    adapter: geminiAdapter,
  },
]

const PROVIDER_MAP = new Map<string, ProviderDef>(PROVIDER_DEFS.map((p) => [p.id, p]))

/** Get the adapter for a given provider ID. Throws if unknown. */
export function getAdapter(providerId: string): ProviderAdapter {
  const def = PROVIDER_MAP.get(providerId)
  if (!def) throw new Error(`Unknown AI provider: "${providerId}"`)
  return def.adapter
}

/** Get the full provider definition (includes default model list). */
export function getProviderDef(providerId: string): ProviderDef {
  const def = PROVIDER_MAP.get(providerId)
  if (!def) throw new Error(`Unknown AI provider: "${providerId}"`)
  return def
}

/** All registered provider IDs. */
export function listProviderIds(): string[] {
  return PROVIDER_DEFS.map((p) => p.id)
}
