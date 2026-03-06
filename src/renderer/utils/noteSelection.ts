/**
 * Utilities for building and formatting NoteSelectionAttachment objects.
 *
 * Used by:
 *   NoteEditor.vue  — copy handler (build from TipTap selection)
 *   ChatSidebar.vue / AIPromptModal.vue — prompt injection (format for model)
 */

import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { NoteSelectionAttachment } from '../types/noteSelection'

// ── Block-level node type names that constitute a "line" ──────────────────────
// Any top-level block whose pos range overlaps the TipTap selection contributes
// one "block" to the range.  Inline nodes inside list items are counted as part
// of their parent list item block.
const BLOCK_NODE_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'taskList',
  'taskItem',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'table',
  'image',
])

/**
 * Walk the top-level children of `doc` (depth=1 children of the root doc node),
 * treating each as one "block line".  Returns the list in order.
 */
function collectTopLevelBlocks(doc: ProseMirrorNode): Array<{ node: ProseMirrorNode; from: number; to: number }> {
  const blocks: Array<{ node: ProseMirrorNode; from: number; to: number }> = []
  doc.forEach((node, offset) => {
    // offset is the position of the node's opening token inside the doc.
    // The node's content spans [offset+1, offset+node.nodeSize-1] (exclusive of
    // the opening/closing tokens), but for overlap checks we use the full range
    // [offset, offset + node.nodeSize].
    if (BLOCK_NODE_TYPES.has(node.type.name)) {
      blocks.push({ node, from: offset, to: offset + node.nodeSize })
    }
  })
  return blocks
}

/**
 * Serialize a single top-level block node to plain text.
 * Task items are rendered with their checkbox state: "- [ ] " or "- [x] ".
 * List items and paragraphs use their textContent.
 */
function serializeBlock(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case 'taskItem': {
      const checked: boolean = node.attrs['checked'] === true
      return `- [${checked ? 'x' : ' '}] ${node.textContent}`
    }
    case 'taskList': {
      // Recurse into task items
      const lines: string[] = []
      node.forEach((child) => {
        if (child.type.name === 'taskItem') {
          const checked: boolean = child.attrs['checked'] === true
          lines.push(`- [${checked ? 'x' : ' '}] ${child.textContent}`)
        } else {
          lines.push(child.textContent)
        }
      })
      return lines.join('\n')
    }
    case 'bulletList': {
      const lines: string[] = []
      node.forEach((child) => {
        lines.push(`- ${child.textContent}`)
      })
      return lines.join('\n')
    }
    case 'orderedList': {
      const lines: string[] = []
      let i = node.attrs['start'] as number ?? 1
      node.forEach((child) => {
        lines.push(`${i}. ${child.textContent}`)
        i++
      })
      return lines.join('\n')
    }
    case 'heading': {
      const level = node.attrs['level'] as number ?? 1
      return `${'#'.repeat(level)} ${node.textContent}`
    }
    case 'codeBlock': {
      const lang = (node.attrs['language'] as string | null) ?? ''
      return `\`\`\`${lang}\n${node.textContent}\n\`\`\``
    }
    case 'blockquote':
      return node.textContent
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'horizontalRule':
      return '---'
    default:
      return node.textContent
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build a NoteSelectionAttachment from the editor's current selection.
 * Returns null when the selection is empty or when the selection does not
 * overlap any recognised top-level block nodes.
 */
export function buildNoteSelectionAttachment(
  editor: Editor,
  noteId: string,
  noteTitle: string,
  from: number,
  to: number,
): NoteSelectionAttachment | null {
  if (from === to) return null

  const doc = editor.state.doc
  const blocks = collectTopLevelBlocks(doc)

  // Find which blocks overlap with [from, to]
  const overlapping = blocks
    .map((b, idx) => ({ ...b, idx }))
    .filter((b) => b.from < to && b.to > from)

  if (overlapping.length === 0) return null

  const blockStart = overlapping[0].idx + 1  // 1-based
  const blockEnd   = overlapping[overlapping.length - 1].idx + 1  // 1-based

  // Serialize the overlapping blocks to plain text
  const selectedText = overlapping
    .map((b) => serializeBlock(b.node))
    .join('\n')
    .trim()

  return { noteId, noteTitle, blockStart, blockEnd, selectedText }
}

/**
 * Format a NoteSelectionAttachment as a labelled context block for injection
 * into an AI prompt.  The surrounding XML-like tags help Claude parse the
 * boundary cleanly.
 *
 * Example output:
 * ```
 * --- Note Selection: "Q2 Planning" (blocks 7–9) ---
 * - [ ] Define scope
 * - [ ] Write RFC
 * - [ ] Kickoff call
 * ---
 * ```
 */
export function formatNoteSelectionForPrompt(attachment: NoteSelectionAttachment): string {
  const header = `--- Note Selection: "${attachment.noteTitle}" (blocks ${attachment.blockStart}–${attachment.blockEnd}) ---`
  return `${header}\n${attachment.selectedText}\n---`
}

/**
 * Format multiple NoteSelectionAttachments wrapped in a single <note_selections>
 * block, ready to prepend to the user message content sent to the model.
 */
export function formatNoteSelectionsForPrompt(attachments: NoteSelectionAttachment[]): string {
  if (attachments.length === 0) return ''
  const blocks = attachments.map(formatNoteSelectionForPrompt).join('\n\n')
  return `<note_selections>\n${blocks}\n</note_selections>\n\n`
}
