/**
 * OpenAI embedding client.
 * Lazy singleton — instantiated on first use, replaced when the API key changes.
 * Uses text-embedding-3-small (1536d) matching the vec0 FLOAT[1536] schema.
 */

import OpenAI from 'openai'

let _client: OpenAI | null = null
let _currentKey = ''

const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536
const BATCH_SIZE = 100  // OpenAI supports up to 2048; 100 is a safe batch size

export interface EmbeddingResult {
  index: number
  embedding: Float32Array
}

/** Update (or clear) the OpenAI client when the API key changes. */
export function setOpenAIKey(apiKey: string): void {
  if (apiKey === _currentKey) return
  _client = apiKey ? new OpenAI({ apiKey }) : null
  _currentKey = apiKey
}

/**
 * Embed an array of texts using the OpenAI embeddings API.
 * Batches requests to stay within API limits.
 * Returns a Float32Array per input — the correct binary format for sqlite-vec BLOB storage.
 * Throws on API error — callers should handle and treat as a non-fatal pipeline failure.
 */
export async function embedTexts(texts: string[]): Promise<EmbeddingResult[]> {
  if (!_client) throw new Error('OpenAI client not initialized — set the API key first')

  const results: EmbeddingResult[] = []

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE)
    const response = await _client.embeddings.create({
      model: MODEL,
      input: batch,
      dimensions: DIMENSIONS,
      encoding_format: 'float',
    })
    for (const item of response.data) {
      results.push({
        index: i + item.index,
        embedding: new Float32Array(item.embedding),
      })
    }
  }

  return results
}
