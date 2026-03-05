/**
 * Canonical registry of all AI feature slots in the app.
 *
 * A "feature slot" is a named AI task that can be assigned a user-configured
 * model chain (primary + ordered fallbacks). The app calls every AI operation
 * through the model router using one of these slot IDs — no model is hardcoded
 * anywhere else.
 *
 * Each slot declares the required model capability so the Settings UI only
 * offers compatible models in the chain builder dropdowns.
 */

export const FEATURE_SLOTS = [
  {
    id: 'chat',
    label: 'AI Chat (conversation)',
    description: 'Conversational responses in the AI chat sidebar.',
    capability: 'chat',
  },
  {
    id: 'daily_brief',
    label: 'Daily Brief',
    description: 'Generates the structured morning briefing.',
    capability: 'chat',
  },
  {
    id: 'note_summary',
    label: 'Note Summary (L2)',
    description: 'Background per-note summary for semantic search.',
    capability: 'chat',
  },
  {
    id: 'ner',
    label: 'Entity Detection (NER)',
    description: 'Auto-detects entity mentions in notes after save.',
    capability: 'chat',
  },
  {
    id: 'action_extract',
    label: 'Action Item Extraction',
    description: 'Extracts tasks and commitments from note content.',
    capability: 'chat',
  },
  {
    id: 'inline_ai',
    label: 'Inline AI Generation',
    description: 'Generates content inside the note editor on demand.',
    capability: 'chat',
  },
  {
    id: 'meeting_summary',
    label: 'Meeting Transcript Summary',
    description: 'Post-processes transcripts into structured meeting notes.',
    capability: 'chat',
  },
  {
    id: 'cluster_summary',
    label: 'Cluster Summaries (L3)',
    description: 'Generates theme labels for note clusters in the nightly batch.',
    capability: 'chat',
  },
  {
    id: 'query_expand',
    label: 'Query Expansion',
    description: 'Expands search queries with synonyms and related concepts.',
    capability: 'chat',
  },
  {
    id: 'rerank',
    label: 'Search Re-ranking',
    description: 'Re-scores semantic search results for relevance.',
    capability: 'chat',
  },
  {
    id: 'embedding',
    label: 'Vector Embeddings',
    description: 'Generates vector embeddings for notes and chunks.',
    capability: 'embedding',
  },
] as const

export type FeatureSlotId = typeof FEATURE_SLOTS[number]['id']
export type ModelCapability = 'chat' | 'embedding'

/** Default model chain for each slot — used when the user has not configured one. */
export const DEFAULT_CHAINS: Record<FeatureSlotId, string[]> = {
  chat:            ['claude-sonnet-4-6'],
  daily_brief:     ['claude-sonnet-4-6'],
  note_summary:    ['claude-haiku-4-5-20251001'],
  ner:             ['claude-haiku-4-5-20251001'],
  action_extract:  ['claude-haiku-4-5-20251001'],
  inline_ai:       ['claude-haiku-4-5-20251001'],
  meeting_summary: ['claude-haiku-4-5-20251001'],
  cluster_summary: ['claude-haiku-4-5-20251001'],
  query_expand:    ['claude-haiku-4-5-20251001'],
  rerank:          ['claude-haiku-4-5-20251001'],
  embedding:       ['text-embedding-3-small'],
}
