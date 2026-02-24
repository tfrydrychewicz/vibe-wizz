/**
 * Embedding pipeline orchestrator.
 * Called fire-and-forget after every notes:update save.
 *
 * Flow:
 *   1. Skip early if sqlite-vec isn't loaded or no API key is configured
 *   2. Delete existing L1 chunks + embeddings for the note (vec0 has no CASCADE)
 *   3. Chunk the note's body_plain text
 *   4. Embed all chunk contexts in a single batched OpenAI API call
 *   5. Store chunks in note_chunks and embeddings in chunk_embeddings
 *
 * Errors are caught and logged — pipeline failures never surface to the user.
 */

import { getDatabase, isVecLoaded } from '../db/index'
import { chunkText } from './chunker'
import { setOpenAIKey, embedTexts } from './embedder'

/** Fire-and-forget entry point. Call after notes:update without await. */
export function scheduleEmbedding(noteId: string): void {
  runPipeline(noteId).catch((err) => {
    console.error('[Embedding] Pipeline error for note', noteId, ':', err)
  })
}

async function runPipeline(noteId: string): Promise<void> {
  if (!isVecLoaded()) return

  const db = getDatabase()

  // Read API key at runtime so key changes take effect without restart
  const setting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('openai_api_key') as { value: string } | undefined
  const apiKey = setting?.value ?? ''
  if (!apiKey) return

  setOpenAIKey(apiKey)

  // Load current note content
  const note = db
    .prepare('SELECT title, body_plain FROM notes WHERE id = ?')
    .get(noteId) as { title: string; body_plain: string } | undefined

  // Always clear stale chunks first (even if the note is now empty or deleted)
  deleteChunks(db, noteId)

  if (!note?.body_plain.trim()) return

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
    console.error('[Embedding] OpenAI API error:', err)
    deleteChunks(db, noteId)
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

  console.log(`[Embedding] Stored ${chunks.length} chunk(s) for note ${noteId}`)
}

/**
 * Delete L1 chunks and their embeddings for a note.
 * IMPORTANT: vec0 virtual tables do NOT support ON DELETE CASCADE.
 * Must delete from chunk_embeddings BEFORE note_chunks.
 */
function deleteChunks(db: ReturnType<typeof getDatabase>, noteId: string): void {
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
