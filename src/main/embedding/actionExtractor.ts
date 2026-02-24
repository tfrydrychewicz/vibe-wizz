/**
 * Action item extraction via Claude Haiku.
 * Identifies concrete tasks and commitments in a note's plain-text body.
 * Part of the background embedding pipeline — fire-and-forget after note save.
 */

import Anthropic from '@anthropic-ai/sdk'

// Haiku: fast and cheap — appropriate for fire-and-forget background extraction
const MODEL = 'claude-haiku-4-5-20251001'

// Keep prompts manageable; 4000 chars ≈ 1000 tokens of note content
const MAX_BODY_CHARS = 4000

// Cap per note to avoid inserting noise
const MAX_ACTIONS = 20

export interface ExtractedAction {
  title: string
}

/**
 * Extract action items from a note body using Claude Haiku.
 * Returns up to MAX_ACTIONS items with concise, imperative titles.
 * Throws on API error — callers should handle and treat as non-fatal.
 */
export async function extractActionItems(
  noteTitle: string,
  bodyPlain: string,
  apiKey: string
): Promise<ExtractedAction[]> {
  if (!bodyPlain.trim()) return []

  const client = new Anthropic({ apiKey })

  const truncated =
    bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Extract action items from the following note. An action item is a concrete task, commitment, or follow-up that someone needs to do.

Note title: ${noteTitle}

Note content:
${truncated}

Respond with ONLY a JSON array. Each element must have:
- "title": short, imperative description (e.g. "Schedule 1:1 with Sarah", "Review Q3 OKRs", "Send meeting recap")

Rules:
- Only extract explicit tasks, not general information or observations
- Keep titles concise (under 80 characters)
- If there are no clear action items, respond with []
- Do not extract the same action twice`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') return []

  try {
    const text = block.text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '')
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return []

    return (parsed as unknown[])
      .filter((item): item is { title: string } => {
        if (!item || typeof item !== 'object') return false
        const r = item as Record<string, unknown>
        return typeof r['title'] === 'string' && r['title'].trim().length > 0
      })
      .map((item) => ({ title: item.title.trim() }))
      .slice(0, MAX_ACTIONS)
  } catch {
    return []
  }
}
