/**
 * Embedding client.
 * Routes through the model router — no hardcoded model or API key.
 * Uses the provider adapter's embed() method (OpenAI, Gemini).
 */

import { callWithFallback } from '../ai/modelRouter'
import { getDatabase } from '../db/index'

export interface EmbeddingResult {
  index: number
  embedding: Float32Array
}

/**
 * Embed an array of texts using the configured embedding model.
 * Batching is handled by the provider adapter.
 * Returns a Float32Array per input — the correct binary format for sqlite-vec BLOB storage.
 * Throws on API error — callers should handle and treat as a non-fatal pipeline failure.
 */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
  if (texts.length === 0) return []

  const db = getDatabase()

  return callWithFallback('embedding', db, async (model) => {
    if (!model.adapter.embed) {
      throw new Error(`Provider "${model.providerId}" does not support embeddings`)
    }
    const results = await model.adapter.embed(texts, model.modelId, model.apiKey)
    return results.map((r) => ({ index: r.index, embedding: r.embedding }))
  })
}
