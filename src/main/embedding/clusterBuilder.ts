/**
 * L3 cluster summary pipeline.
 *
 * Reads all L2 per-note summaries, re-embeds them, runs K-means++ clustering,
 * generates a Claude Haiku theme summary per cluster, and persists the results
 * as layer=3 rows in note_chunks + cluster_embeddings.
 *
 * Called once per nightly batch via scheduler.ts.
 */

import Anthropic from '@anthropic-ai/sdk'
import Database from 'better-sqlite3'
import { setOpenAIKey, embedTexts } from './embedder'
import { kmeansPP, cosineDist } from './kmeans'

let _client: Anthropic | null = null
let _currentKey = ''

const MODEL = 'claude-haiku-4-5-20251001'

/** Update (or clear) the Anthropic client when the API key changes. */
export function setAnthropicKey(apiKey: string): void {
  if (apiKey === _currentKey) return
  _client = apiKey ? new Anthropic({ apiKey }) : null
  _currentKey = apiKey
}

/**
 * Build L3 cluster summaries from all L2 note summaries.
 *
 * Flow:
 *  1. Read all layer=2 rows from note_chunks (note_id + chunk_text)
 *  2. Re-embed all L2 summaries via OpenAI (batched)
 *  3. Run K-means++ (K = sqrt(N/2), clamped 2–20)
 *  4. For each cluster: pick top-5 reps, call Claude Haiku, embed summary
 *  5. Delete all existing layer=3 data, then insert new clusters
 */
export async function runL3Clustering(
  db: Database.Database,
  openaiKey: string,
  anthropicKey: string
): Promise<void> {
  setOpenAIKey(openaiKey)
  setAnthropicKey(anthropicKey)

  if (!_client) {
    console.warn('[Cluster] Anthropic client not initialized — skipping L3 batch')
    return
  }

  // ── 1. Read all L2 summaries ──────────────────────────────────────────────
  const l2Rows = db
    .prepare('SELECT id, note_id, chunk_text FROM note_chunks WHERE layer = 2')
    .all() as { id: number; note_id: string; chunk_text: string }[]

  if (l2Rows.length < 5) {
    console.log(`[Cluster] Only ${l2Rows.length} L2 summaries — need at least 5 to cluster`)
    return
  }

  const N = l2Rows.length
  console.log(`[Cluster] Embedding ${N} L2 summaries for clustering...`)

  // ── 2. Re-embed all L2 summaries ─────────────────────────────────────────
  let embedResults: Awaited<ReturnType<typeof embedTexts>>
  try {
    embedResults = await embedTexts(l2Rows.map((r) => r.chunk_text))
  } catch (err) {
    console.error('[Cluster] OpenAI embedding error during L3 batch:', err)
    return
  }

  // Build parallel arrays of embeddings + metadata
  const points: Float32Array[] = embedResults.map(
    (r) => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
  )
  const noteIds = l2Rows.map((r) => r.note_id)
  const summaryTexts = l2Rows.map((r) => r.chunk_text)

  // ── 3. K-means++ clustering ───────────────────────────────────────────────
  const K = Math.max(2, Math.min(20, Math.round(Math.sqrt(N / 2))))
  console.log(`[Cluster] Running K-means++ with K=${K} on ${N} notes...`)

  const { centroids, assignments } = kmeansPP(points, K)

  // ── 4. Generate cluster summaries ────────────────────────────────────────
  const clusterChunks: {
    noteId: string
    summaryText: string
    memberNoteIds: string[]
    embedding: Float32Array
  }[] = []

  for (let c = 0; c < K; c++) {
    // Collect all members of this cluster
    const memberIndices: number[] = []
    for (let i = 0; i < N; i++) {
      if (assignments[i] === c) memberIndices.push(i)
    }
    if (memberIndices.length === 0) continue

    const memberNoteIds = memberIndices.map((i) => noteIds[i])

    // Select top-5 representatives (closest to centroid)
    const ranked = memberIndices
      .map((i) => ({ i, dist: cosineDist(points[i], centroids[c]) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5)

    const repSummaries = ranked.map(({ i }) => summaryTexts[i])

    // Generate cluster theme via Claude Haiku
    let clusterSummary: string
    try {
      clusterSummary = await generateClusterSummary(repSummaries)
    } catch (err) {
      console.error(`[Cluster] Claude error for cluster ${c}:`, err)
      continue
    }

    // Embed the cluster summary
    let clusterEmbedResults: Awaited<ReturnType<typeof embedTexts>>
    try {
      clusterEmbedResults = await embedTexts([clusterSummary])
    } catch (err) {
      console.error(`[Cluster] OpenAI embedding error for cluster ${c}:`, err)
      continue
    }

    const clusterEmbedding = clusterEmbedResults[0].embedding

    clusterChunks.push({
      noteId: noteIds[ranked[0].i], // anchor to most representative note
      summaryText: clusterSummary,
      memberNoteIds,
      embedding: clusterEmbedding,
    })
  }

  if (clusterChunks.length === 0) {
    console.warn('[Cluster] No cluster summaries generated — aborting write')
    return
  }

  // ── 5. Replace existing L3 data ──────────────────────────────────────────
  // IMPORTANT: must delete from cluster_embeddings BEFORE note_chunks
  // (vec0 virtual tables do NOT support ON DELETE CASCADE)
  const existingL3 = db
    .prepare('SELECT id FROM note_chunks WHERE layer = 3')
    .all() as { id: number }[]

  if (existingL3.length > 0) {
    const delVec = db.prepare('DELETE FROM cluster_embeddings WHERE rowid = ?')
    db.transaction(() => {
      for (const { id } of existingL3) delVec.run(BigInt(id))
    })()
  }
  db.prepare('DELETE FROM note_chunks WHERE layer = 3').run()

  // Insert new cluster rows
  const insertChunk = db.prepare(
    `INSERT INTO note_chunks (note_id, chunk_text, chunk_context, layer, position)
     VALUES (?, ?, ?, 3, ?)`
  )
  const insertVec = db.prepare('INSERT INTO cluster_embeddings(rowid, embedding) VALUES (?, ?)')

  db.transaction(() => {
    for (let i = 0; i < clusterChunks.length; i++) {
      const { noteId, summaryText, memberNoteIds, embedding } = clusterChunks[i]
      const result = insertChunk.run(
        noteId,
        summaryText,
        JSON.stringify(memberNoteIds), // chunk_context stores all member note IDs for search boost
        i
      )
      const rowid = BigInt(result.lastInsertRowid)
      insertVec.run(rowid, Buffer.from(embedding.buffer))
    }
  })()

  console.log(`[Cluster] Stored ${clusterChunks.length} L3 cluster(s) covering ${N} notes`)
}

/** Call Claude Haiku to generate a 2–4 sentence theme description for a cluster. */
async function generateClusterSummary(repSummaries: string[]): Promise<string> {
  if (!_client) throw new Error('Anthropic client not initialized')

  const notesBlock = repSummaries
    .map((s, i) => `Note ${i + 1}: ${s}`)
    .join('\n\n')

  const response = await _client.messages.create({
    model: MODEL,
    max_tokens: 200,
    messages: [
      {
        role: 'user',
        content: `The following are summaries of related notes. In 2-4 sentences, describe the shared theme or topic of this cluster of notes. Be specific and factual. Write in the same language as the summaries.

${notesBlock}

Cluster theme:`,
      },
    ],
  })

  const block = response.content[0]
  if (block.type !== 'text') throw new Error('Unexpected response type from Claude')
  return block.text.trim()
}
