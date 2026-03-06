/**
 * Named Entity Recognition (NER).
 * Identifies which known entities are mentioned in a note's plain-text body.
 * Part of the background embedding pipeline — fire-and-forget after note save.
 * Routes through the model router (no hardcoded model or API key).
 */

import { callWithFallback } from '../ai/modelRouter'
import { getDatabase } from '../db/index'
import { getCurrentDateString } from '../utils/date'

// Keep prompts manageable; 4000 chars ≈ 1000 tokens of note content
const MAX_BODY_CHARS = 4000

// Cap to avoid exceeding context limit with very large entity lists
const MAX_ENTITIES = 150

// Minimum confidence to keep a detection (filters out speculative guesses)
const MIN_CONFIDENCE = 0.6

export interface NerDetection {
  entityId: string
  confidence: number
}

/**
 * Detect which known entities are mentioned in a note body.
 * Returns entity IDs with confidence scores (0.0–1.0), filtered to >= MIN_CONFIDENCE.
 * Throws on API error — callers should handle and treat as a non-fatal pipeline failure.
 *
 * @param entities - candidate entities; optional `aliases` are additional field values
 *                   (e.g. email, nickname) that the AI should also match against.
 */
export async function detectEntityMentions(
  noteTitle: string,
  bodyPlain: string,
  entities: { id: string; name: string; aliases?: string[] }[],
): Promise<NerDetection[]> {
  if (!entities.length || !bodyPlain.trim()) return []

  const db = getDatabase()
  const truncated =
    bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  const entitySubset = entities.slice(0, MAX_ENTITIES)
  const hasAliases = entitySubset.some((e) => e.aliases?.length)
  const entityList = entitySubset
    .map((e) => {
      const obj: Record<string, unknown> = { id: e.id, name: e.name }
      if (e.aliases?.length) obj.also_known_as = e.aliases
      return JSON.stringify(obj)
    })
    .join('\n')

  return callWithFallback('ner', db, async (model) => {
    const result = await model.adapter.chat(
      {
        model: model.modelId,
        maxTokens: 512,
        messages: [
          {
            role: 'user',
            content:
              `Today is ${getCurrentDateString()}.\n\n` +
              'Analyze the following note and identify which known entities are mentioned or clearly ' +
              `referenced in it (by name, ${hasAliases ? 'alias (also_known_as field), ' : ''}pronoun, or unambiguous implication).\n\n` +
              `Known entities (JSON, one per line):\n${entityList}\n\n` +
              `Note title: ${noteTitle}\n\nNote content:\n${truncated}\n\n` +
              'Respond with ONLY a JSON array. Each element must have:\n' +
              '- "entity_id": the exact id string from the known entities list\n' +
              '- "confidence": float 0.0–1.0 (1.0 = exact name match; lower for indirect references)\n\n' +
              'Do not include entities not in the known entities list. If none are mentioned, respond with [].',
          },
        ],
      },
      model.apiKey,
    )

    const block = result.rawBlocks.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') return []

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
  })
}
