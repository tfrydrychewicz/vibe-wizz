/**
 * Shared model list for all AI features in the renderer.
 * Mirrors the AVAILABLE_MODELS export in src/main/embedding/chat.ts.
 * Keep in sync when adding new models.
 */
export const MODELS = [
  { id: 'claude-opus-4-6',           label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const

export type ChatModelId = typeof MODELS[number]['id']

export const DEFAULT_CHAT_MODEL: ChatModelId = 'claude-sonnet-4-6'
