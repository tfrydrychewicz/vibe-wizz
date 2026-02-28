/**
 * Action item extraction via Claude Haiku.
 * Identifies concrete tasks and commitments in a note's plain-text body.
 * Part of the background embedding pipeline — fire-and-forget after note save.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getCurrentDateString } from '../utils/date'

// Default: Haiku — fast and cheap for fire-and-forget background extraction
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'

// Keep prompts manageable; 4000 chars ≈ 1000 tokens of note content
const MAX_BODY_CHARS = 4000

// Cap per note to avoid inserting noise
const MAX_ACTIONS = 20

export interface ExtractedAction {
  title: string
}

export interface ExtractedActions {
  heading: string
  items: ExtractedAction[]
}

/**
 * Extract action items from a note body using Claude Haiku.
 * Returns a localized heading and up to MAX_ACTIONS items with concise, imperative titles.
 * The heading and titles are in the same language as the note content.
 * Throws on API error — callers should handle and treat as non-fatal.
 */
export async function extractActionItems(
  noteTitle: string,
  bodyPlain: string,
  apiKey: string,
  model = DEFAULT_MODEL
): Promise<ExtractedActions> {
  if (!bodyPlain.trim()) return { heading: 'Action Items', items: [] }

  const client = new Anthropic({ apiKey })

  const truncated =
    bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  const response = await client.messages.create({
    model: model,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Today is ${getCurrentDateString()}.\n\nExtract action items from the following note. An action item is a concrete task, commitment, or follow-up that someone needs to do.

Note title: ${noteTitle}

Note content:
${truncated}

Respond with ONLY a JSON object with two keys:
- "heading": the phrase "Action Items" translated into the same language as the note content
- "items": array where each element has:
  - "title": short, imperative description (e.g. "Schedule 1:1 with Sarah", "Review Q3 OKRs", "Send meeting recap")

Rules:
- Respond in the same language as the note content
- Only extract explicit tasks, not general information or observations
- Keep titles concise (under 80 characters)
- If there are no clear action items, respond with { "heading": "<translated heading>", "items": [] }
- Do not extract the same action twice`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') return { heading: 'Action Items', items: [] }

  try {
    const text = block.text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '')
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { heading: 'Action Items', items: [] }

    const obj = parsed as Record<string, unknown>
    const heading = typeof obj['heading'] === 'string' && obj['heading'].trim()
      ? obj['heading'].trim()
      : 'Action Items'
    const rawItems = Array.isArray(obj['items']) ? obj['items'] : []

    const items = (rawItems as unknown[])
      .filter((item): item is { title: string } => {
        if (!item || typeof item !== 'object') return false
        const r = item as Record<string, unknown>
        return typeof r['title'] === 'string' && r['title'].trim().length > 0
      })
      .map((item) => ({ title: item.title.trim() }))
      .slice(0, MAX_ACTIONS)

    return { heading, items }
  } catch {
    return { heading: 'Action Items', items: [] }
  }
}
