/**
 * Embedding pipeline orchestrator.
 *
 * Three separate pipelines:
 *  - runNerPipeline:       NER entity detection only — runs on every note save
 *  - runEmbeddingPipeline: L1 chunk embeddings + L2 note summary — deferred to focus loss
 *  - runPipeline:          NER + L1+L2 concurrently — used by postProcessor.ts after transcription
 *
 * Errors are caught and logged — pipeline failures never surface to the user.
 */

import { getDatabase, isVecLoaded } from '../db/index'
import { chunkText } from './chunker'
import { setOpenAIKey, embedTexts } from './embedder'
import { setAnthropicKey, summarizeNote } from './summarizer'
import { detectEntityMentions, type NerDetection } from './ner'
import { pushToRenderer } from '../push'

/** Fire-and-forget: full pipeline (NER + L1+L2). Used by postProcessor.ts after transcription. */
export function scheduleEmbedding(noteId: string): void {
  runPipeline(noteId).catch((err) => {
    console.error('[Embedding] Pipeline error for note', noteId, ':', err)
  })
}

/** Fire-and-forget: NER only. Called from notes:update on every save. */
export function scheduleNer(noteId: string): void {
  runNerPipeline(noteId).catch((err) => {
    console.error('[NER] Pipeline error for note', noteId, ':', err)
  })
}

/** Fire-and-forget: L1+L2 embeddings only. Called when a note loses focus. */
export function scheduleEmbeddingOnly(noteId: string): void {
  runEmbeddingPipeline(noteId).catch((err) => {
    console.error('[Embedding] L1/L2 pipeline error for note', noteId, ':', err)
  })
}

/**
 * Startup recovery: sequentially re-embed all notes with embedding_dirty = 1.
 * Called once at app startup after initDatabase().
 * Sequential to avoid flooding the OpenAI API.
 */
export async function processDirtyNotes(): Promise<void> {
  const db = getDatabase()
  const dirty = db
    .prepare(
      `SELECT id FROM notes
       WHERE embedding_dirty = 1 AND archived_at IS NULL
       ORDER BY updated_at DESC LIMIT 50`
    )
    .all() as { id: string }[]

  if (!dirty.length) return

  console.log(`[Embedding] ${dirty.length} dirty note(s) queued for startup re-embedding`)
  for (const { id } of dirty) {
    await runEmbeddingPipeline(id)
  }
}

/** Full pipeline: NER + L1+L2 concurrently. */
async function runPipeline(noteId: string): Promise<void> {
  await Promise.all([runNerPipeline(noteId), runEmbeddingPipeline(noteId)])
}

/** NER entity detection only. */
async function runNerPipeline(noteId: string): Promise<void> {
  const db = getDatabase()

  const anthropicSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('anthropic_api_key') as { value: string } | undefined
  const anthropicKey = anthropicSetting?.value ?? ''

  if (!anthropicKey) return

  const bgModelSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('model_background') as { value: string } | undefined
  const backgroundModel = bgModelSetting?.value || 'claude-haiku-4-5-20251001'

  const note = db
    .prepare('SELECT title, body_plain FROM notes WHERE id = ?')
    .get(noteId) as { title: string; body_plain: string } | undefined

  if (!note?.body_plain.trim()) return

  await runNer(noteId, note.title, note.body_plain, anthropicKey, db, backgroundModel)
  pushToRenderer('note:ner-complete', { noteId })
}

/**
 * L1 chunk embeddings + L2 note summary.
 * Clears embedding_dirty = 0 on successful completion.
 */
async function runEmbeddingPipeline(noteId: string): Promise<void> {
  const db = getDatabase()

  const openaiSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('openai_api_key') as { value: string } | undefined
  const openaiKey = openaiSetting?.value ?? ''

  if (!isVecLoaded() || !openaiKey) return

  const anthropicSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('anthropic_api_key') as { value: string } | undefined
  const anthropicKey = anthropicSetting?.value ?? ''

  const bgModelSetting = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('model_background') as { value: string } | undefined
  const backgroundModel = bgModelSetting?.value || 'claude-haiku-4-5-20251001'

  const note = db
    .prepare('SELECT title, body_plain FROM notes WHERE id = ?')
    .get(noteId) as { title: string; body_plain: string } | undefined

  setOpenAIKey(openaiKey)

  // Always clear stale L1 chunks first (even if the note is now empty or deleted)
  deleteL1Chunks(db, noteId)

  if (!note?.body_plain.trim()) {
    deleteL2Summary(db, noteId)
    db.prepare('UPDATE notes SET embedding_dirty = 0 WHERE id = ?').run(noteId)
    return
  }

  await runL1Chunks(noteId, note.title, note.body_plain, db)
  if (anthropicKey) {
    setAnthropicKey(anthropicKey)
    await runL2Summary(noteId, note.title, note.body_plain, db, backgroundModel)
  }

  // Clear the dirty flag on successful completion
  db.prepare('UPDATE notes SET embedding_dirty = 0 WHERE id = ?').run(noteId)
}

async function runL1Chunks(
  noteId: string,
  title: string,
  bodyPlain: string,
  db: ReturnType<typeof getDatabase>
): Promise<void> {
  const chunks = chunkText(bodyPlain, title)
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
}

async function runL2Summary(
  noteId: string,
  title: string,
  bodyPlain: string,
  db: ReturnType<typeof getDatabase>,
  model: string
): Promise<void> {
  // Delete any existing L2 summary for this note first
  deleteL2Summary(db, noteId)

  let summary: string
  try {
    summary = await summarizeNote(title, bodyPlain, model)
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

async function runNer(
  noteId: string,
  title: string,
  bodyPlain: string,
  anthropicKey: string,
  db: ReturnType<typeof getDatabase>,
  model: string
): Promise<void> {
  // Get all non-trashed entities to scan for
  const entities = db
    .prepare('SELECT id, name FROM entities WHERE trashed_at IS NULL ORDER BY name COLLATE NOCASE')
    .all() as { id: string; name: string }[]

  if (!entities.length) return

  // Exclude entities already manually tagged in this note — no need to double-detect them
  const manualRows = db
    .prepare(
      `SELECT entity_id FROM entity_mentions WHERE note_id = ? AND mention_type = 'manual'`
    )
    .all(noteId) as { entity_id: string }[]
  const manualIds = new Set(manualRows.map((r) => r.entity_id))
  const candidates = entities.filter((e) => !manualIds.has(e.id))

  if (!candidates.length) return

  let detected: NerDetection[]
  try {
    detected = await detectEntityMentions(title, bodyPlain, candidates, anthropicKey, model)
  } catch (err) {
    console.error('[NER] Claude API error:', err)
    return
  }

  // Replace previous auto-detected mentions for this note with fresh results
  db.prepare(
    `DELETE FROM entity_mentions WHERE note_id = ? AND mention_type = 'auto_detected'`
  ).run(noteId)

  if (!detected.length) {
    console.log(`[NER] No entity mentions detected for note ${noteId}`)
    return
  }

  const insertMention = db.prepare(
    `INSERT INTO entity_mentions (note_id, entity_id, mention_type, confidence)
     VALUES (?, ?, 'auto_detected', ?)`
  )
  db.transaction(() => {
    for (const { entityId, confidence } of detected) {
      insertMention.run(noteId, entityId, confidence)
    }
  })()

  console.log(`[NER] Detected ${detected.length} entity mention(s) for note ${noteId}`)
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
