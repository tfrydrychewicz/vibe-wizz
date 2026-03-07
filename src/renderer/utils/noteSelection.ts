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

// ── Inline content serializer ─────────────────────────────────────────────────
/**
 * Recursively serialize a ProseMirror node's content to plain text, preserving
 * @mention and [[noteLink]] references that are invisible to `node.textContent`
 * (which returns '' for atomic nodes like mention/noteLink).
 *
 * Block-level children are separated by '\n'; inline children are concatenated
 * without separators (matching the visual flow of a paragraph's inline content).
 */
function getNodeText(node: ProseMirrorNode): string {
  // Atomic inline reference nodes — serialize with ID + name so the model can
  // unambiguously identify the referenced entity/note (names are not unique).
  // Format matches the token used by the inline AI bubble: {{entity:id:label}}
  if (node.type.name === 'mention') {
    return `{{entity:${node.attrs['id'] as string}:${node.attrs['label'] as string}}}`
  }
  if (node.type.name === 'noteLink') {
    return `{{note:${node.attrs['id'] as string}:${node.attrs['label'] as string}}}`
  }
  // Plain text leaf
  if (node.isText) {
    return node.text ?? ''
  }
  // Container node — recurse into children
  const parts: string[] = []
  node.forEach((child) => {
    parts.push(getNodeText(child))
  })
  // Block-level containers (paragraph inside listItem, etc.) get newline separation;
  // inline containers (marks, etc.) are joined without separator.
  return parts.join(node.isBlock && !node.isInline ? '\n' : '')
}

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
 * Serialize a single top-level block node to plain text, optionally restricted
 * to only the child list items that overlap [selFrom, selTo].
 *
 * `blockPos` is the document position of the block's opening token (b.from).
 * When provided alongside selFrom/selTo, list nodes (taskList, bulletList,
 * orderedList) will filter their children to only those that overlap the
 * selection — so copying M tasks out of N only yields those M tasks.
 */
function serializeBlock(
  node: ProseMirrorNode,
  blockPos?: number,
  selFrom?: number,
  selTo?: number,
): string {
  // Whether we should filter list children to the selection window.
  const hasRange = blockPos !== undefined && selFrom !== undefined && selTo !== undefined

  switch (node.type.name) {
    case 'taskItem': {
      const checked: boolean = node.attrs['checked'] === true
      return `- [${checked ? 'x' : ' '}] ${getNodeText(node)}`
    }
    case 'taskList': {
      const lines: string[] = []
      // blockPos + 1 = position after the list's opening token (first child starts here)
      let childPos = hasRange ? blockPos! + 1 : 0
      node.forEach((child) => {
        const childFrom = childPos
        const childTo = childPos + child.nodeSize
        const inRange = !hasRange || (childFrom < selTo! && childTo > selFrom!)
        if (inRange) {
          if (child.type.name === 'taskItem') {
            const checked: boolean = child.attrs['checked'] === true
            lines.push(`- [${checked ? 'x' : ' '}] ${getNodeText(child)}`)
          } else {
            lines.push(getNodeText(child))
          }
        }
        childPos += child.nodeSize
      })
      return lines.join('\n')
    }
    case 'bulletList': {
      const lines: string[] = []
      let childPos = hasRange ? blockPos! + 1 : 0
      node.forEach((child) => {
        const childFrom = childPos
        const childTo = childPos + child.nodeSize
        const inRange = !hasRange || (childFrom < selTo! && childTo > selFrom!)
        if (inRange) lines.push(`- ${getNodeText(child)}`)
        childPos += child.nodeSize
      })
      return lines.join('\n')
    }
    case 'orderedList': {
      const lines: string[] = []
      let childPos = hasRange ? blockPos! + 1 : 0
      let i = node.attrs['start'] as number ?? 1
      node.forEach((child) => {
        const childFrom = childPos
        const childTo = childPos + child.nodeSize
        const inRange = !hasRange || (childFrom < selTo! && childTo > selFrom!)
        if (inRange) lines.push(`${i}. ${getNodeText(child)}`)
        // Always advance i so original numbering is preserved for partial selections
        i++
        childPos += child.nodeSize
      })
      return lines.join('\n')
    }
    case 'heading': {
      const level = node.attrs['level'] as number ?? 1
      return `${'#'.repeat(level)} ${getNodeText(node)}`
    }
    case 'codeBlock': {
      const lang = (node.attrs['language'] as string | null) ?? ''
      return `\`\`\`${lang}\n${getNodeText(node)}\n\`\`\``
    }
    case 'blockquote':
      return getNodeText(node)
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
    case 'horizontalRule':
      return '---'
    default:
      return getNodeText(node)
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

  // Serialize the overlapping blocks to plain text.
  // Pass blockPos + selection range so list nodes can filter to only the
  // child items the user actually selected (fixes partial task-list copies).
  const selectedText = overlapping
    .map((b) => serializeBlock(b.node, b.from, from, to))
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
