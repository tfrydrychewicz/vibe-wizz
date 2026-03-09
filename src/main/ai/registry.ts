/**
 * Provider registry.
 *
 * Maps provider IDs to their adapters and curated model lists.
 * This is the single place where new providers are registered.
 */

import { anthropicAdapter, ANTHROPIC_POPULAR_MODELS } from './providers/anthropic'
import { openaiAdapter, OPENAI_POPULAR_MODELS } from './providers/openai'
import { geminiAdapter, GEMINI_POPULAR_MODELS } from './providers/gemini'
import { ollamaAdapter, OLLAMA_POPULAR_MODELS } from './providers/ollama'
import type { ProviderAdapter, ModelDef } from './providers/types'

// ── Provider definition ───────────────────────────────────────────────────────

export interface ProviderDef {
  id: string
  label: string
  /** Models to show in Settings when no live /models fetch has been run yet */
  popularModels: ModelDef[]
  adapter: ProviderAdapter
  /**
   * How the provider authenticates. Defaults to 'api_key'.
   * - 'api_key': user enters a secret key (masked input, show/hide toggle)
   * - 'base_url': user enters a URL stored in the api_key column (plain text input)
   */
  credentialType?: 'api_key' | 'base_url'
  /** Pre-filled value shown when the provider is first added in Settings. */
  credentialDefault?: string
  /** Placeholder text for the credential input in Settings. */
  credentialPlaceholder?: string
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
  {
    id: 'ollama',
    label: 'Ollama (local)',
    popularModels: OLLAMA_POPULAR_MODELS,
    adapter: ollamaAdapter,
    credentialType: 'base_url',
    credentialDefault: 'http://localhost:11434',
    credentialPlaceholder: 'http://localhost:11434',
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
