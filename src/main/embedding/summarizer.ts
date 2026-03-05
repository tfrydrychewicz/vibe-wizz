/**
 * Claude-based note summarizer.
 * Generates a 2-4 sentence summary of a note for L2 embedding storage.
 * Routes through the model router (no hardcoded model or API key).
 */

import { callWithFallback } from '../ai/modelRouter'
import { getDatabase } from '../db/index'
import { getCurrentDateString } from '../utils/date'

// Truncate body_plain to keep API calls fast and within token limits
const MAX_BODY_CHARS = 6000

/**
 * Generate a retrieval-focused summary of a note.
 * The summary is stored as a layer=2 chunk and embedded for semantic search.
 * Throws on API error — callers should handle and treat as a non-fatal pipeline failure.
 */
export async function summarizeNote(title: string, bodyPlain: string): Promise<string> {
  const db = getDatabase()
  const truncated = bodyPlain.length > MAX_BODY_CHARS ? bodyPlain.slice(0, MAX_BODY_CHARS) + '…' : bodyPlain

  return callWithFallback('note_summary', db, async (model) => {
    const result = await model.adapter.chat(
      {
        model: model.modelId,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content:
              `Today is ${getCurrentDateString()}.\n\n` +
              'Summarize the following note in 2-4 sentences for semantic search indexing. ' +
              'Capture the main topics, decisions, and key information. Be factual and specific.\n\n' +
              `Note title: ${title}\n\nNote content:\n${truncated}\n\nSummary:`,
          },
        ],
      },
      model.apiKey,
    )
    if (!result.text.trim()) throw new Error('Empty response from model')
    return result.text.trim()
  })
}
