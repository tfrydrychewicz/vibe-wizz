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

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'
const MAX_TRANSCRIPT_CHARS = 8000
const MAX_NOTE_CHARS = 4000

// ── TipTap JSON helpers ────────────────────────────────────────────────────────

interface TipTapMark {
  type: string
}

interface TipTapTextNode {
  type: 'text'
  text: string
  marks?: TipTapMark[]
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

/**
 * Parse inline markdown into TipTap text nodes with marks.
 * Priority: ***___ bold+italic > **__ bold > *_ italic > `code`
 */
function parseInlineMarkdown(text: string): TipTapTextNode[] {
  const nodes: TipTapTextNode[] = []
  // Groups: [1]=***  [2]=___  [3]=**  [4]=__  [5]=*  [6]=_  [7]=`code`
  const pattern = /\*\*\*(.+?)\*\*\*|___(.+?)___|\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`(.+?)`/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push({ type: 'text', text: text.slice(lastIndex, match.index) })
    }

    if (match[1] !== undefined || match[2] !== undefined) {
      nodes.push({ type: 'text', text: (match[1] ?? match[2])!, marks: [{ type: 'bold' }, { type: 'italic' }] })
    } else if (match[3] !== undefined || match[4] !== undefined) {
      nodes.push({ type: 'text', text: (match[3] ?? match[4])!, marks: [{ type: 'bold' }] })
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push({ type: 'text', text: (match[5] ?? match[6])!, marks: [{ type: 'italic' }] })
    } else if (match[7] !== undefined) {
      nodes.push({ type: 'text', text: match[7], marks: [{ type: 'code' }] })
    }

    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    nodes.push({ type: 'text', text: text.slice(lastIndex) })
  }

  // ProseMirror forbids empty text nodes — return [] for empty input
  if (!text) return []
  return nodes.length > 0 ? nodes : [{ type: 'text', text }]
}

function paragraph(text: string): TipTapNode {
  return { type: 'paragraph', content: parseInlineMarkdown(text) }
}

function heading(level: number, text: string): TipTapNode {
  return {
    type: 'heading',
    attrs: { level },
    content: parseInlineMarkdown(text),
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
 * Handles headings, horizontal rules, blockquotes, fenced code blocks,
 * task lists, bullet lists, and plain paragraphs.
 */
export function parseMarkdownToTipTap(markdown: string): TipTapNode[] {
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

    // Horizontal rule: ---, ***, ___  (3+ chars, all same)
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      nodes.push({ type: 'horizontalRule' })
      i++
      continue
    }

    // Fenced code block: ```lang … ```
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim() || null
      const codeLines: string[] = []
      i++
      while (i < lines.length) {
        if (lines[i].trim() === '```') { i++; break }
        codeLines.push(lines[i])
        i++
      }
      nodes.push({
        type: 'codeBlock',
        attrs: { language: lang },
        content: [{ type: 'text', text: codeLines.join('\n') }],
      })
      continue
    }

    // Blockquote: collect consecutive "> " lines
    if (line.startsWith('> ')) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const ql = lines[i].trim()
        if (ql.startsWith('> ')) {
          quoteLines.push(ql.slice(2))
          i++
        } else if (!ql) {
          i++; break
        } else {
          break
        }
      }
      nodes.push({
        type: 'blockquote',
        content: quoteLines.map((l) => ({ type: 'paragraph', content: parseInlineMarkdown(l) })),
      })
      continue
    }

    // Task list — collect consecutive - [ ] / - [x] items into a taskList node
    if (line.match(/^- \[[ xX]\] /)) {
      const taskItems: TipTapNode[] = []
      while (i < lines.length) {
        const tl = lines[i].trim()
        const taskMatch = tl.match(/^- \[([ xX])\] (.+)$/)
        if (taskMatch) {
          taskItems.push({
            type: 'taskItem',
            attrs: { checked: taskMatch[1].toLowerCase() === 'x' },
            content: [{ type: 'paragraph', content: parseInlineMarkdown(taskMatch[2]) }],
          })
          i++
        } else if (!tl) {
          i++
          break
        } else {
          break
        }
      }
      if (taskItems.length > 0) nodes.push({ type: 'taskList', content: taskItems })
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
            content: [{ type: 'paragraph', content: parseInlineMarkdown(bl.slice(2)) }],
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

    // GFM table: pipe-delimited rows with a separator line
    if (line.startsWith('|')) {
      let peekIdx = i + 1
      while (peekIdx < lines.length && !lines[peekIdx].trim()) peekIdx++
      const sepLine = peekIdx < lines.length ? lines[peekIdx].trim() : ''
      const isSeparator = /^\|[\s\-:|]+\|[\s\-:|]*$/.test(sepLine)

      if (isSeparator) {
        const tableRows: string[] = []
        while (i < lines.length) {
          const tl = lines[i].trim()
          if (tl.startsWith('|')) {
            tableRows.push(tl)
            i++
          } else if (!tl) {
            i++
            break
          } else {
            break
          }
        }

        if (tableRows.length >= 2) {
          const parseRowCells = (rowLine: string): string[] =>
            rowLine.split('|').slice(1, -1).map((c) => c.trim())

          const headerCells = parseRowCells(tableRows[0])
          // Only filter rows where every cell (after trim) is a real GFM
          // separator cell (non-empty, only dashes/colons). The old regex
          // matched all-pipe/space rows (empty cells) and would incorrectly
          // drop valid body rows that happen to have only empty cells.
          const isSeparatorRow = (row: string): boolean => {
            const cells = row.trim().split('|').slice(1, -1).map((c) => c.trim())
            return cells.length > 0 && cells.every((c) => c.length > 0 && /^[:\-]+$/.test(c))
          }
          const bodyRows = tableRows.slice(2).filter((r) => !isSeparatorRow(r))

          // ProseMirror forbids empty text nodes — use empty paragraph content
          // for cells that have no text, instead of { type: 'text', text: '' }.
          const makeCell = (text: string, isHeader: boolean): TipTapNode => ({
            type: isHeader ? 'tableHeader' : 'tableCell',
            attrs: { colspan: 1, rowspan: 1, colwidth: null },
            content: [{ type: 'paragraph', content: text ? parseInlineMarkdown(text) : [] }],
          })

          nodes.push({
            type: 'table',
            content: [
              { type: 'tableRow', content: headerCells.map((c) => makeCell(c, true)) },
              ...bodyRows.map((row) => ({
                type: 'tableRow',
                content: parseRowCells(row).map((c) => makeCell(c, false)),
              })),
            ],
          })
        }
        continue
      }
      // No separator follows — treat as plain paragraph text and advance.
      // Without this, the paragraph handler below breaks immediately on the
      // '|' guard without advancing i, causing an infinite loop.
      nodes.push(paragraph(line))
      i++
      continue
    }

    // Paragraph — collect consecutive non-special lines
    const paraLines: string[] = []
    while (i < lines.length) {
      const pl = lines[i].trim()
      if (!pl) { i++; break }
      if (
        pl.match(/^#{1,6}\s/) ||
        pl.startsWith('- ') || pl.startsWith('* ') ||
        pl.startsWith('> ') || pl.startsWith('```') ||
        pl.startsWith('|') ||
        /^(-{3,}|\*{3,}|_{3,})$/.test(pl)
      ) break
      paraLines.push(pl)
      i++
    }
    if (paraLines.length > 0) nodes.push(paragraph(paraLines.join(' ')))
  }

  return nodes
}

// ── AI: speaker-to-attendee matching ──────────────────────────────────────────

/**
 * Given a speaker-labeled transcript (e.g. "[Speaker 0]: hello\n[Speaker 1]: hi")
 * and a list of meeting attendee names, ask Claude Haiku to map each speaker
 * number to an attendee name.  Returns a partial map — unresolved speakers are
 * left with their "Speaker N" label.
 */
async function matchSpeakersToAttendees(
  transcript: string,
  attendeeNames: string[],
  apiKey: string,
  model: string,
): Promise<Record<string, string>> {
  if (!apiKey || attendeeNames.length < 2) return {}

  // Collect all distinct speaker IDs that appear in the transcript
  const speakerIds = new Set<string>()
  for (const m of transcript.matchAll(/\[Speaker (\d+)\]:/g)) speakerIds.add(m[1])
  if (speakerIds.size < 2) return {}

  const prompt = `You are analyzing a meeting transcript with numbered speaker labels.

Meeting attendees:
${attendeeNames.map((n, i) => `${i + 1}. ${n}`).join('\n')}

Transcript excerpt (first 3000 chars):
${transcript.slice(0, 3000)}

Based on the conversation, map each Speaker number to the most likely attendee name.
Reply ONLY with a JSON object like {"0": "Alice Smith", "1": "Bob Jones"}.
Only include speakers you can identify with reasonable confidence. If unsure, reply with {}.
No explanation, only JSON.`

  const client = new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content[0]
    if (block.type !== 'text') return {}
    const jsonMatch = block.text.trim().match(/\{[\s\S]*\}/)
    if (!jsonMatch) return {}
    return JSON.parse(jsonMatch[0]) as Record<string, string>
  } catch {
    return {}
  }
}

/** Replace [Speaker N] labels with matched attendee names. */
function applySpeakerNames(transcript: string, speakerMap: Record<string, string>): string {
  if (Object.keys(speakerMap).length === 0) return transcript
  return transcript.replace(/\[Speaker (\d+)\]/g, (_, id: string) =>
    speakerMap[id] ? `[${speakerMap[id]}]` : `[Speaker ${id}]`,
  )
}

// ── AI: merge transcript + manual notes ───────────────────────────────────────

async function generateMergedNote(
  rawTranscript: string,
  noteBodyPlain: string,
  apiKey: string,
  model: string,
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
- Use markdown: ## for section headings, - for regular bullets, - [ ] for action items and tasks
- In the "Action Items / Follow-ups" section use - [ ] checkbox syntax for every task so they render as interactive checkboxes in the editor
- Include sections only where there is relevant content: Meeting Summary, Key Decisions, Action Items / Follow-ups

Manual notes:
${truncatedNotes}

Transcript:
${truncatedTranscript}

Write only the note content, no preamble or meta-commentary.`
    : `You are summarizing a meeting transcript. Produce a concise, well-structured note using the same language as the transcript.

Use markdown: ## headings, - for regular bullets, - [ ] for action items and tasks. In the "Action Items / Follow-ups" section use - [ ] checkbox syntax for every task so they render as interactive checkboxes in the editor. Include sections only where relevant: Meeting Summary, Key Decisions, Action Items / Follow-ups.

Transcript:
${truncatedTranscript}

Write only the note content, no preamble.`

  const client = new Anthropic({ apiKey })
  try {
    const response = await client.messages.create({
      model: model,
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
  attendeeNames?: string[],
  model = DEFAULT_MODEL,
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

  // If the transcript has speaker labels and attendees are known, resolve Speaker N → name
  let labeledTranscript = rawTranscript
  if (attendeeNames && attendeeNames.length >= 2 && rawTranscript.includes('[Speaker ')) {
    const speakerMap = await matchSpeakersToAttendees(rawTranscript, attendeeNames, anthropicKey, model)
    if (Object.keys(speakerMap).length > 0) {
      labeledTranscript = applySpeakerNames(rawTranscript, speakerMap)
      console.log('[Transcription] Speaker map resolved:', speakerMap)
    }
  }

  // Persist the transcription session row (speaker-resolved transcript stored)
  const transcriptionId = randomUUID()
  if (startedAt) {
    db.prepare(
      `INSERT INTO note_transcriptions (id, note_id, started_at, ended_at, raw_transcript)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(transcriptionId, noteId, startedAt, endedAt ?? null, labeledTranscript)
  }

  // Generate merged note (transcript + user's existing notes, graceful on failure)
  const mergedContent = await generateMergedNote(labeledTranscript, noteBodyPlain, anthropicKey, model)

  // Store merged content as the session summary for the history panel
  if (startedAt && mergedContent) {
    db.prepare('UPDATE note_transcriptions SET summary = ? WHERE id = ?').run(
      mergedContent,
      transcriptionId,
    )
  }

  // Replace note body with merged content (or append transcript as fallback).
  // Use the speaker-resolved transcript so the fallback raw section shows names.
  updateNoteWithTranscript(noteId, mergedContent, labeledTranscript)

  // Trigger embedding pipeline (NER + action extraction + embeddings)
  scheduleEmbedding(noteId)

  // Signal renderer to reload the note
  pushToRenderer('transcription:complete', { noteId })

  console.log('[Transcription] Post-processing complete for note', noteId)
}
