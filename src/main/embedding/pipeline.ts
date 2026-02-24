/**
 * Embedding pipeline orchestrator.
 * Called fire-and-forget after every notes:update save.
 *
 * Flow:
 *   1. Skip early if sqlite-vec isn't loaded or no OpenAI API key is configured
 *   2. Delete existing L1 chunks + embeddings for the note (vec0 has no CASCADE)
 *   3. Chunk the note's body_plain text
 *   4. Embed all chunk contexts in a single batched OpenAI API call
 *   5. Store chunks in note_chunks and embeddings in chunk_embeddings
 *   6. (L2) If Anthropic API key is set, generate a note summary via Claude Haiku,
 *      embed it via OpenAI, and store in note_chunks (layer=2) + summary_embeddings
 *
 * Errors are caught and logged — pipeline failures never surface to the user.
 */

import { getDatabase, isVecLoaded } from '../db/index'
import { chunkText } from './chunker'
import { setOpenAIKey, embedTexts } from './embedder'
import { setAnthropicKey, summarizeNote } from './summarizer'

/** Fire-and-forget entry point. Call after notes:update without await. */
export function scheduleEmbedding(noteId: string): void {
  runPipeline(noteId).catch((err) => {
    console.error('[Embedding] Pipeline error for note', noteId, ':', err)
  })
}

async function runPipeline(noteId: string): Promise<void> {
  if (!isVecLoaded()) return

  const db = getDatabase()

  // Read API keys at runtime so key changes take effect without restart
  const openaiSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('openai_api_key') as { value: string } | undefined
  const openaiKey = openaiSetting?.value ?? ''
  if (!openaiKey) return

  setOpenAIKey(openaiKey)

  // Load current note content
  const note = db
    .prepare('SELECT title, body_plain FROM notes WHERE id = ?')
    .get(noteId) as { title: string; body_plain: string } | undefined

  // Always clear stale L1 chunks first (even if the note is now empty or deleted)
  deleteL1Chunks(db, noteId)

  if (!note?.body_plain.trim()) {
    deleteL2Summary(db, noteId)
    return
  }

  // --- L1: Raw chunks ---
  const chunks = chunkText(note.body_plain, note.title)
  if (chunks.length === 0) return

  // Insert chunks and capture the autoincrement rowids (= chunk_embeddings foreign key).
  // Use BigInt so better-sqlite3 always binds via sqlite3_bind_int64 → SQLITE_INTEGER.
  // sqlite-vec vec0 rejects SQLITE_REAL primary key values even when the value is
  // a whole number, so passing a JS `number` (which may be bound as REAL) is not safe.
  const insertChunk = db.prepare(
    `INSERT INTO note_chunks (note_id, chunk_text, chunk_context, layer, position)
     VALUES (?, ?, ?, 1, ?)`
  )
  const rowids: bigint[] = []
  for (const chunk of chunks) {
    const result = insertChunk.run(noteId, chunk.text, chunk.context, chunk.position)
    rowids.push(BigInt(result.lastInsertRowid))
  }

  // Generate embeddings (single batched API call for all chunks)
  let embedResults
  try {
    embedResults = await embedTexts(chunks.map((c) => c.context))
  } catch (err) {
    // Roll back orphaned chunk rows so we don't have chunks without embeddings
    console.error('[Embedding] OpenAI API error (L1):', err)
    deleteL1Chunks(db, noteId)
    return
  }

  // Store embeddings in vec0 table.
  // note_chunks.id (INTEGER PRIMARY KEY AUTOINCREMENT) = chunk_embeddings.rowid
  // Float32Array.buffer is the correct binary format for sqlite-vec BLOB storage.
  const insertVec = db.prepare('INSERT INTO chunk_embeddings(rowid, embedding) VALUES (?, ?)')
  db.transaction(() => {
    for (const r of embedResults) {
      insertVec.run(rowids[r.index], Buffer.from(r.embedding.buffer))
    }
  })()

  console.log(`[Embedding] Stored ${chunks.length} L1 chunk(s) for note ${noteId}`)

  // --- L2: Note summary (requires Anthropic API key) ---
  const anthropicSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('anthropic_api_key') as { value: string } | undefined
  const anthropicKey = anthropicSetting?.value ?? ''
  if (!anthropicKey) return

  setAnthropicKey(anthropicKey)
  await runL2Summary(noteId, note.title, note.body_plain, db)
}

async function runL2Summary(
  noteId: string,
  title: string,
  bodyPlain: string,
  db: ReturnType<typeof getDatabase>
): Promise<void> {
  // Delete any existing L2 summary for this note first
  deleteL2Summary(db, noteId)

  let summary: string
  try {
    summary = await summarizeNote(title, bodyPlain)
  } catch (err) {
    console.error('[Embedding] Claude API error (L2 summary):', err)
    return
  }

  // Insert summary as a layer=2 chunk; context = same text (summary is already the condensed form)
  const result = db
    .prepare(
      `INSERT INTO note_chunks (note_id, chunk_text, chunk_context, layer, position)
       VALUES (?, ?, ?, 2, 0)`
    )
    .run(noteId, summary, summary)
  const rowid = BigInt(result.lastInsertRowid)

  // Embed the summary and store in summary_embeddings
  let embedResults
  try {
    embedResults = await embedTexts([summary])
  } catch (err) {
    console.error('[Embedding] OpenAI API error (L2 embedding):', err)
    // Roll back the orphaned summary chunk
    db.prepare('DELETE FROM note_chunks WHERE id = ?').run(rowid)
    return
  }

  db.prepare('INSERT INTO summary_embeddings(rowid, embedding) VALUES (?, ?)').run(
    rowid,
    Buffer.from(embedResults[0].embedding.buffer)
  )

  console.log(`[Embedding] Stored L2 summary for note ${noteId}`)
}

/**
 * Delete L1 chunks and their embeddings for a note.
 * IMPORTANT: vec0 virtual tables do NOT support ON DELETE CASCADE.
 * Must delete from chunk_embeddings BEFORE note_chunks.
 */
function deleteL1Chunks(db: ReturnType<typeof getDatabase>, noteId: string): void {
  const rows = db
    .prepare('SELECT id FROM note_chunks WHERE note_id = ? AND layer = 1')
    .all(noteId) as { id: number }[]

  if (rows.length > 0) {
    const delVec = db.prepare('DELETE FROM chunk_embeddings WHERE rowid = ?')
    db.transaction(() => {
      for (const { id } of rows) delVec.run(BigInt(id))
    })()
  }

  db.prepare('DELETE FROM note_chunks WHERE note_id = ? AND layer = 1').run(noteId)
}

/**
 * Delete the L2 summary chunk and its embedding for a note.
 * IMPORTANT: vec0 virtual tables do NOT support ON DELETE CASCADE.
 * Must delete from summary_embeddings BEFORE note_chunks.
 */
function deleteL2Summary(db: ReturnType<typeof getDatabase>, noteId: string): void {
  const rows = db
    .prepare('SELECT id FROM note_chunks WHERE note_id = ? AND layer = 2')
    .all(noteId) as { id: number }[]

  if (rows.length > 0) {
    const delVec = db.prepare('DELETE FROM summary_embeddings WHERE rowid = ?')
    db.transaction(() => {
      for (const { id } of rows) delVec.run(BigInt(id))
    })()
  }

  db.prepare('DELETE FROM note_chunks WHERE note_id = ? AND layer = 2').run(noteId)
}
