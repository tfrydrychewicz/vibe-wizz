/**
 * Post-meeting transcript processor.
 *
 * After a transcription session ends:
 * 1. Generate a structured meeting summary via Claude Haiku
 * 2. Append the summary + raw transcript to the linked note's TipTap body
 * 3. Trigger the embedding pipeline on the updated note
 * 4. Push transcription:complete to the renderer so the editor reloads
 */

import Anthropic from '@anthropic-ai/sdk'
import { getDatabase } from '../db/index'
import { scheduleEmbedding } from '../embedding/pipeline'
import { pushToRenderer } from '../push'

const MODEL = 'claude-haiku-4-5-20251001'
const MAX_TRANSCRIPT_CHARS = 8000

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

/** Split markdown/plain text into paragraph nodes, preserving blank-line separation. */
function buildParagraphNodes(text: string): TipTapNode[] {
  return text
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => paragraph(block))
}

/** Build the TipTap nodes appended to the note after transcription ends. */
function buildTranscriptNodes(summary: string, rawTranscript: string): TipTapNode[] {
  const nodes: TipTapNode[] = [{ type: 'horizontalRule' }]
  nodes.push(heading(2, 'Transcript Summary'))
  if (summary) {
    nodes.push(...buildParagraphNodes(summary))
  }
  if (rawTranscript.trim()) {
    nodes.push(heading(3, 'Raw Transcript'))
    nodes.push(...buildParagraphNodes(rawTranscript))
  }
  return nodes
}

// ── AI summary generation ──────────────────────────────────────────────────────

async function generateTranscriptSummary(rawTranscript: string, apiKey: string): Promise<string> {
  if (!rawTranscript.trim() || !apiKey) return ''

  const truncated =
    rawTranscript.length > MAX_TRANSCRIPT_CHARS
      ? rawTranscript.slice(0, MAX_TRANSCRIPT_CHARS) + '…'
      : rawTranscript

  const client = new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: `You are summarizing a meeting transcript. Produce a concise structured summary using the same language as the transcript. Include these sections (only if relevant content exists):

## Meeting Summary
A 2-4 sentence overview of what was discussed.

## Key Decisions
Bullet points of decisions made (if any).

## Follow-ups
Bullet points of open questions or items that need follow-up (if any).

Transcript:
${truncated}

Write only the summary sections, no preamble.`,
        },
      ],
    })
    const block = response.content[0]
    return block.type === 'text' ? block.text.trim() : ''
  } catch (err) {
    console.error('[Transcription] Summary generation failed:', err)
    return ''
  }
}

// ── Note update ────────────────────────────────────────────────────────────────

function appendTranscriptToNote(noteId: string, summary: string, rawTranscript: string): void {
  const db = getDatabase()
  const note = db.prepare('SELECT body, body_plain FROM notes WHERE id = ?').get(noteId) as
    | { body: string; body_plain: string }
    | undefined
  if (!note) {
    console.error('[Transcription] Note not found for post-processing:', noteId)
    return
  }

  // Parse existing TipTap body
  let doc: TipTapDoc
  try {
    doc = JSON.parse(note.body || '{"type":"doc","content":[]}') as TipTapDoc
  } catch {
    doc = { type: 'doc', content: [] }
  }

  // Append transcript nodes
  const transcriptNodes = buildTranscriptNodes(summary, rawTranscript)
  doc.content = [...(doc.content ?? []), ...transcriptNodes]

  // Build updated plain text
  const appendPlain = [
    summary ? `\n\nTranscript Summary\n${summary}` : '',
    rawTranscript.trim() ? `\n\nRaw Transcript\n${rawTranscript}` : '',
  ]
    .filter(Boolean)
    .join('')
  const newBodyPlain = note.body_plain + appendPlain

  db.prepare(
    `UPDATE notes SET body = ?, body_plain = ?, source = 'transcript', updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(doc), newBodyPlain, new Date().toISOString(), noteId)
}

// ── Entry point ────────────────────────────────────────────────────────────────

export async function processTranscript(
  noteId: string,
  rawTranscript: string,
  anthropicKey: string,
): Promise<void> {
  if (!rawTranscript.trim()) {
    // Still push completion so the editor knows recording stopped
    pushToRenderer('transcription:complete', { noteId })
    return
  }

  console.log('[Transcription] Post-processing note', noteId)

  // Generate AI summary (graceful on failure)
  const summary = await generateTranscriptSummary(rawTranscript, anthropicKey)

  // Append to note in DB
  appendTranscriptToNote(noteId, summary, rawTranscript)

  // Trigger embedding pipeline (NER + action extraction + embeddings)
  scheduleEmbedding(noteId)

  // Signal renderer to reload the note
  pushToRenderer('transcription:complete', { noteId })

  console.log('[Transcription] Post-processing complete for note', noteId)
}
