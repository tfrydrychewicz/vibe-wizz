/**
 * Action item extraction.
 * Identifies concrete tasks and commitments in a note's plain-text body.
 * Part of the background embedding pipeline — fire-and-forget after note save.
 * Routes through the model router (no hardcoded model or API key).
 */

import { callWithFallback } from '../ai/modelRouter'
import { getDatabase } from '../db/index'
import { getCurrentDateString } from '../utils/date'
import { deriveTaskAttributes } from './taskClarifier'

// Keep prompts manageable; 4000 chars ≈ 1000 tokens of note content
const MAX_BODY_CHARS = 4000

// Cap per note to avoid inserting noise
const MAX_ACTIONS = 20

export interface ExtractedAction {
  title: string
  project_entity_id: string | null
  project_name: string | null
  due_date: string | null
  contexts: string[]
  energy_level: 'low' | 'medium' | 'high' | null
  confidence: number
}

export interface ExtractedActions {
  heading: string
  items: ExtractedAction[]
}

/**
 * Extract action items from a note body.
 * Returns a localized heading and up to MAX_ACTIONS items with concise, imperative titles.
 * The heading and titles are in the same language as the note content.
 * Throws on API error — callers should handle and treat as non-fatal.
 */
export async function extractActionItems(
  noteTitle: string,
  bodyPlain: string,
): Promise<ExtractedActions> {
  if (!bodyPlain.trim()) return { heading: 'Action Items', items: [] }

  const db = getDatabase()
  const truncated =
    bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  return callWithFallback('action_extract', db, async (model) => {
    const result = await model.adapter.chat(
      {
        model: model.modelId,
        maxTokens: 512,
        messages: [
          {
            role: 'user',
            content:
              `Today is ${getCurrentDateString()}.\n\n` +
              'Extract action items from the following note. An action item is a concrete task, ' +
              'commitment, or follow-up that someone needs to do.\n\n' +
              `Note title: ${noteTitle}\n\nNote content:\n${truncated}\n\n` +
              'Respond with ONLY a JSON object with two keys:\n' +
              '- "heading": the phrase "Action Items" translated into the same language as the note content\n' +
              '- "items": array where each element has:\n' +
              '  - "title": short, imperative description (e.g. "Schedule 1:1 with Sarah", "Review Q3 OKRs")\n\n' +
              'Rules:\n' +
              '- Respond in the same language as the note content\n' +
              '- Only extract explicit tasks, not general information or observations\n' +
              '- Keep titles concise (under 80 characters)\n' +
              '- If there are no clear action items, respond with { "heading": "<translated heading>", "items": [] }\n' +
              '- Do not extract the same action twice',
          },
        ],
      },
      model.apiKey,
    )

    const block = result.rawBlocks.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') return { heading: 'Action Items', items: [] }

    const text = block.text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '')
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { heading: 'Action Items', items: [] }

    const obj = parsed as Record<string, unknown>
    const heading =
      typeof obj['heading'] === 'string' && obj['heading'].trim()
        ? obj['heading'].trim()
        : 'Action Items'
    const rawItems = Array.isArray(obj['items']) ? obj['items'] : []

    const rawTitles = (rawItems as unknown[])
      .filter((item): item is { title: string } => {
        if (!item || typeof item !== 'object') return false
        const r = item as Record<string, unknown>
        return typeof r['title'] === 'string' && r['title'].trim().length > 0
      })
      .map((item) => item.title.trim())
      .slice(0, MAX_ACTIONS)

    // Batch-derive GTD attributes for all extracted items in parallel
    const derived = await Promise.all(
      rawTitles.map((title) =>
        deriveTaskAttributes(title, truncated, '').catch(() => null)
      )
    )

    const items: ExtractedAction[] = rawTitles.map((title, i) => {
      const d = derived[i]
      const useGtd = (d?.confidence ?? 0) >= 0.5
      return {
        title,
        project_entity_id: useGtd ? (d?.project_entity_id ?? null) : null,
        project_name: useGtd ? (d?.project_name ?? null) : null,
        due_date: useGtd ? (d?.due_date ?? null) : null,
        contexts: useGtd ? (d?.contexts ?? []) : [],
        energy_level: useGtd ? (d?.energy_level ?? null) : null,
        confidence: d?.confidence ?? 0,
      }
    })

    return { heading, items }
  })
}
