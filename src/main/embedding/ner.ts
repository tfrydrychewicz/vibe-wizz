/**
 * Named Entity Recognition (NER) via Claude Haiku.
 * Identifies which known entities are mentioned in a note's plain-text body.
 * Part of the background embedding pipeline — fire-and-forget after note save.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getCurrentDateString } from '../utils/date'

// Default: Haiku — fast and cheap for fire-and-forget background NER
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// Keep prompts manageable; 4000 chars ≈ 1000 tokens of note content
const MAX_BODY_CHARS = 4000

// Cap to avoid exceeding Haiku's context limit with very large entity lists
const MAX_ENTITIES = 150

// Minimum confidence to keep a detection (filters out speculative guesses)
const MIN_CONFIDENCE = 0.6

export interface NerDetection {
  entityId: string
  confidence: number
}

/**
 * Detect which known entities are mentioned in a note body using Claude Haiku.
 * Returns entity IDs with confidence scores (0.0–1.0), filtered to >= MIN_CONFIDENCE.
 * Throws on API error — callers should handle and treat as a non-fatal pipeline failure.
 */
export async function detectEntityMentions(
  noteTitle: string,
  bodyPlain: string,
  entities: { id: string; name: string }[],
  apiKey: string,
  model = DEFAULT_MODEL
): Promise<NerDetection[]> {
  if (!entities.length || !bodyPlain.trim()) return []

  const client = new Anthropic({ apiKey })

  const truncated =
    bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  const entitySubset = entities.slice(0, MAX_ENTITIES)
  const entityList = entitySubset.map((e) => JSON.stringify({ id: e.id, name: e.name })).join('\n')

  const response = await client.messages.create({
    model: model,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Today is ${getCurrentDateString()}.\n\nAnalyze the following note and identify which known entities are mentioned or clearly referenced in it (by name, pronoun, or unambiguous implication).

Known entities (JSON, one per line):
${entityList}

Note title: ${noteTitle}

Note content:
${truncated}

Respond with ONLY a JSON array. Each element must have:
- "entity_id": the exact id string from the known entities list
- "confidence": float 0.0–1.0 (1.0 = exact name match; lower for indirect references)

Do not include entities not in the known entities list. If none are mentioned, respond with [].`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') return []

  try {
    // Strip optional markdown code fences Claude sometimes adds
    const text = block.text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '')
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []

    const validIds = new Set(entitySubset.map((e) => e.id))
    return (parsed as unknown[])
      .filter((item): item is { entity_id: string; confidence: number } => {
        if (!item || typeof item !== 'object') return false
        const r = item as Record<string, unknown>
        return (
          typeof r['entity_id'] === 'string' &&
          validIds.has(r['entity_id']) &&
          typeof r['confidence'] === 'number'
        )
      })
      .map((item) => ({
        entityId: item.entity_id,
        confidence: Math.max(0, Math.min(1, item.confidence)),
      }))
      .filter((r) => r.confidence >= MIN_CONFIDENCE)
  } catch {
    return []
  }
}
