/**
 * Claude-based note summarizer.
 * Generates a 2-4 sentence summary of a note for L2 embedding storage.
 * Lazy singleton — instantiated on first use, replaced when the API key changes.
 */

import Anthropic from '@anthropic-ai/sdk'

let _client: Anthropic | null = null
let _currentKey = ''

// Haiku: fast and cheap — appropriate for fire-and-forget background summarization
const MODEL = 'claude-haiku-4-5-20251001'

// Truncate body_plain to keep API calls fast and within token limits
const MAX_BODY_CHARS = 6000

/** Update (or clear) the Anthropic client when the API key changes. */
export function setAnthropicKey(apiKey: string): void {
  if (apiKey === _currentKey) return
  _client = apiKey ? new Anthropic({ apiKey }) : null
  _currentKey = apiKey
}

/**
 * Generate a retrieval-focused summary of a note using Claude Haiku.
 * The summary is stored as a layer=2 chunk and embedded for semantic search.
 * Throws on API error — callers should handle and treat as a non-fatal pipeline failure.
 */
export async function summarizeNote(title: string, bodyPlain: string): Promise<string> {
  if (!_client) throw new Error('Anthropic client not initialized — set the API key first')

  const truncated = bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  const response = await _client.messages.create({
    model: MODEL,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `Summarize the following note in 2-4 sentences for semantic search indexing. Capture the main topics, decisions, and key information. Be factual and specific.

Note title: ${title}

Note content:
${truncated}

Summary:`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude')
  return block.text.trim()
}
