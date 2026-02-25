/**
 * Post-meeting transcript processor.
 *
 * After a transcription session ends:
 * 1. Generate a merged meeting note via Claude Haiku (transcript + user's existing notes → unified note)
 * 2. Replace the linked note's TipTap body with the merged content
 * 3. Trigger the embedding pipeline on the updated note
 * 4. Push transcription:complete to the renderer so the editor reloads
 *
 * If no Anthropic key is available, falls back to appending the raw transcript.
 */

import { randomUUID } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { getDatabase } from '../db/index'
import { scheduleEmbedding } from '../embedding/pipeline'
import { pushToRenderer } from '../push'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TRANSCRIPT_CHARS = 8000
const MAX_NOTE_CHARS = 4000

// ── TipTap JSON helpers ────────────────────────────────────────────────────────

interface TipTapTextNode {
  type: 'text'
  text: string
}

interface TipTapNode {
  type: string
  attrs?: Record<string, unknown>
  content?: (TipTapNode | TipTapTextNode)[]
}

interface TipTapDoc {
  type: 'doc'
  content: TipTapNode[]
}

function textNode(text: string): TipTapTextNode {
  return { type: 'text', text }
}

function paragraph(text: string): TipTapNode {
  return { type: 'paragraph', content: [textNode(text)] }
}

function heading(level: number, text: string): TipTapNode {
  return {
    type: 'heading',
    attrs: { level },
    content: [textNode(text)],
  }
}

/** Split plain text into paragraph nodes, preserving blank-line separation. */
function buildParagraphNodes(text: string): TipTapNode[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => paragraph(block))
}

/**
 * Parse Claude's markdown output into TipTap nodes.
 * Handles ## headings, - bullet lists, and plain paragraphs.
 */
function parseMarkdownToTipTap(markdown: string): TipTapNode[] {
  const nodes: TipTapNode[] = []
  const lines = markdown.split('\n')
  let i = 0

  while (i < lines.length) {
    const line = lines[i].trim()

    if (!line) {
      i++
      continue
    }

    // Headings: # through ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      nodes.push(heading(headingMatch[1].length, headingMatch[2]))
      i++
      continue
    }

    // Bullet list — collect consecutive - or * items into a bulletList node
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: TipTapNode[] = []
      while (i < lines.length) {
        const bl = lines[i].trim()
        if (bl.startsWith('- ') || bl.startsWith('* ')) {
          items.push({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [textNode(bl.slice(2))] }],
          })
          i++
        } else if (!bl) {
          i++
          break
        } else {
          break
        }
      }
      if (items.length > 0) nodes.push({ type: 'bulletList', content: items })
      continue
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = []
    while (i < lines.length) {
      const pl = lines[i].trim()
      if (!pl) { i++; break }
      if (pl.match(/^#{1,6}\s/) || pl.startsWith('- ') || pl.startsWith('* ')) break
      paraLines.push(pl)
      i++
    }
    if (paraLines.length > 0) nodes.push(paragraph(paraLines.join(' ')))
  }

  return nodes
}

// ── AI: merge transcript + manual notes ───────────────────────────────────────

async function generateMergedNote(
  rawTranscript: string,
  noteBodyPlain: string,
  apiKey: string,
): Promise<string> {
  if (!rawTranscript.trim() || !apiKey) return ''

  const truncatedTranscript =
    rawTranscript.length > MAX_TRANSCRIPT_CHARS
      ? rawTranscript.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
      : rawTranscript

  const truncatedNotes =
    noteBodyPlain.length > MAX_NOTE_CHARS
      ? noteBodyPlain.slice(0, MAX_NOTE_CHARS) + '…'
      : noteBodyPlain

  const hasManualNotes = truncatedNotes.trim().length > 0

  const prompt = hasManualNotes
    ? `You are synthesizing a meeting note. Combine the user's manual notes with the speech transcript into a single, well-structured note.

Rules:
- Preserve all information from the manual notes (user's intent takes priority)
- Add key context, decisions, and follow-ups from the transcript not already in the notes
- Use the same language as the transcript and notes
- Use markdown: ## for section headings, - for bullet points
- Include sections only where there is relevant content: Meeting Summary, Key Decisions, Action Items / Follow-ups

Manual notes:
${truncatedNotes}

Transcript:
${truncatedTranscript}

Write only the note content, no preamble or meta-commentary.`
    : `You are summarizing a meeting transcript. Produce a concise, well-structured note using the same language as the transcript.

Use markdown (## headings, - bullets). Include sections only where relevant: Meeting Summary, Key Decisions, Action Items / Follow-ups.

Transcript:
${truncatedTranscript}

Write only the note content, no preamble.`

  const client = new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content[0]
    return block.type === 'text' ? block.text.trim() : ''
  } catch (err) {
    console.error('[Transcription] Merge generation failed:', err)
    return ''
  }
}

// ── Note update ────────────────────────────────────────────────────────────────

function updateNoteWithTranscript(noteId: string, mergedContent: string, rawTranscript: string): void {
  const db = getDatabase()
  const note = db.prepare('SELECT body, body_plain FROM notes WHERE id = ?').get(noteId) as
    | { body: string; body_plain: string }
    | undefined
  if (!note) {
    console.error('[Transcription] Note not found for post-processing:', noteId)
    return
  }

  if (mergedContent) {
    // Replace note body with the AI-merged content
    const contentNodes = parseMarkdownToTipTap(mergedContent)
    const doc: TipTapDoc = { type: 'doc', content: contentNodes }
    db.prepare(
      `UPDATE notes SET body = ?, body_plain = ?, source = 'transcript', updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(doc), mergedContent, new Date().toISOString(), noteId)
  } else {
    // Fallback (no API key or AI failure): append raw transcript so content isn't lost
    let doc: TipTapDoc
    try {
      doc = JSON.parse(note.body || '{"type":"doc","content":[]}') as TipTapDoc
    } catch {
      doc = { type: 'doc', content: [] }
    }
    const fallbackNodes: TipTapNode[] = [
      { type: 'horizontalRule' },
      heading(3, 'Raw Transcript'),
      ...buildParagraphNodes(rawTranscript),
    ]
    doc.content = [...(doc.content ?? []), ...fallbackNodes]
    const newBodyPlain = note.body_plain + `\n\nRaw Transcript\n${rawTranscript}`
    db.prepare(
      `UPDATE notes SET body = ?, body_plain = ?, source = 'transcript', updated_at = ? WHERE id = ?`,
    ).run(JSON.stringify(doc), newBodyPlain, new Date().toISOString(), noteId)
  }
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function processTranscript(
  noteId: string,
  rawTranscript: string,
  anthropicKey: string,
  startedAt?: string,
  endedAt?: string,
): Promise<void> {
  if (!rawTranscript.trim()) {
    // Still push completion so the editor knows recording stopped
    pushToRenderer('transcription:complete', { noteId })
    return
  }

  console.log('[Transcription] Post-processing note', noteId)

  const db = getDatabase()

  // Read the note's current content before we overwrite it
  const currentNote = db.prepare('SELECT body_plain FROM notes WHERE id = ?').get(noteId) as
    | { body_plain: string }
    | undefined
  const noteBodyPlain = currentNote?.body_plain ?? ''

  // Persist the transcription session row (raw transcript always saved)
  const transcriptionId = randomUUID()
  if (startedAt) {
    db.prepare(
      `INSERT INTO note_transcriptions (id, note_id, started_at, ended_at, raw_transcript)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(transcriptionId, noteId, startedAt, endedAt ?? null, rawTranscript)
  }

  // Generate merged note (transcript + user's existing notes, graceful on failure)
  const mergedContent = await generateMergedNote(rawTranscript, noteBodyPlain, anthropicKey)

  // Store merged content as the session summary for the history panel
  if (startedAt && mergedContent) {
    db.prepare('UPDATE note_transcriptions SET summary = ? WHERE id = ?').run(
      mergedContent,
      transcriptionId,
    )
  }

  // Replace note body with merged content (or append raw transcript as fallback)
  updateNoteWithTranscript(noteId, mergedContent, rawTranscript)

  // Trigger embedding pipeline (NER + action extraction + embeddings)
  scheduleEmbedding(noteId)

  // Signal renderer to reload the note
  pushToRenderer('transcription:complete', { noteId })

  console.log('[Transcription] Post-processing complete for note', noteId)
}
