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

// Minimum confidence to keep a detection.
// Lowered to 0.5 to admit fuzzy matches (inflected forms, partial names, minor typos)
// while still filtering out speculative guesses.
const MIN_CONFIDENCE = 0.5

export interface NerDetection {
  entityId: string
  confidence: number
  /** Exact text fragments found in the note that triggered this match (declined forms, partial names, typos…). */
  matchedTexts: string[]
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
              'Analyze the following note and identify which known entities are mentioned or referenced in it. ' +
              'The note may be written in any language.\n\n' +
              'Match each entity across ALL of these forms:\n' +
              `- Exact canonical name${hasAliases ? ' or alias (also_known_as field)' : ''}\n` +
              '- Grammatically declined or inflected forms — e.g. Polish "Jana" / "Janem" / "Janowi" for "Jan", ' +
              '"Kowalskiego" for "Kowalski"; German genitive "des Herrn Smith"; Russian/Czech/Slovak/Ukrainian ' +
              'case forms; any morphological variant of the name in any language\n' +
              '- Partial name references — first name only, last name only, or any unambiguous subset ' +
              '(e.g. just "Smith" when "John Smith" is the only Smith in the list)\n' +
              '- Names missing one component — e.g. "John" matching "John Smith" when context is clear\n' +
              '- Minor typos or phonetic spelling variants — e.g. "Jhon" for "John", "Kowalsky" for "Kowalski"\n' +
              '- Pronouns or contextual implications that unambiguously refer to a specific entity\n\n' +
              `Known entities (JSON, one per line):\n${entityList}\n\n` +
              `Note title: ${noteTitle}\n\nNote content:\n${truncated}\n\n` +
              'Respond with ONLY a JSON array. Each element must have:\n' +
              '- "entity_id": the exact id string from the known entities list\n' +
              '- "confidence": float 0.0–1.0 using this scale:\n' +
              '  1.0  = exact canonical name or alias match\n' +
              '  0.85 = declined/inflected form or well-known abbreviation\n' +
              '  0.75 = partial name (first or last name only) or minor typo/variant\n' +
              '  0.6  = indirect reference or pronoun where the referent is clear\n' +
              '  0.5  = plausible but ambiguous reference\n' +
              '- "matched_texts": string array — the EXACT substrings from the note content that ' +
              'matched this entity (copy them verbatim, preserving capitalisation and any diacritics). ' +
              'Include every distinct surface form found (e.g. ["Jana", "Janowi"] for entity "Jan Kowalski"). ' +
              'Use [] when the match is purely via pronoun or implication with no named fragment.\n\n' +
              'Do not include entities not in the known entities list. If none are mentioned, respond with [].',
          },
        ],
      },
      model.apiKey,
    )

    const block = result.rawBlocks.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') return []

    const text = block.text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '')
    // Extract only the JSON array — model may append prose after the closing bracket
    const arrayMatch = text.match(/\[[\s\S]*\]/)
    if (!arrayMatch) return []
    const parsed: unknown = JSON.parse(arrayMatch[0])
    if (!Array.isArray(parsed)) return []

    const validIds = new Set(entitySubset.map((e) => e.id))
    return (parsed as unknown[])
      .filter((item): item is { entity_id: string; confidence: number; matched_texts?: unknown } => {
        if (!item || typeof item !== 'object') return false
        const r = item as Record<string, unknown>
        return (
          typeof r['entity_id'] === 'string' &&
          validIds.has(r['entity_id']) &&
          typeof r['confidence'] === 'number'
        )
      })
      .map((item) => {
        const rawMatched = item['matched_texts']
        const matchedTexts: string[] = Array.isArray(rawMatched)
          ? (rawMatched as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
          : []
        return {
          entityId: item.entity_id,
          confidence: Math.max(0, Math.min(1, item.confidence)),
          matchedTexts,
        }
      })
      .filter((r) => r.confidence >= MIN_CONFIDENCE)
  })
}
