/**
 * Converts TipTap note body JSON to HTML for read-only display.
 * Uses the same extension schema as NoteEditor so rendering matches the note view.
 */

import { generateHTML } from '@tiptap/html'
import type { Extensions, JSONContent } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { createLowlight, all } from 'lowlight'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Mention from '@tiptap/extension-mention'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { Underline } from '@tiptap/extension-underline'
import { Highlight } from '@tiptap/extension-highlight'
import { Superscript } from '@tiptap/extension-superscript'
import { Subscript } from '@tiptap/extension-subscript'
import { TextAlign } from '@tiptap/extension-text-align'
import { Callout } from '../extensions/Callout'
import { ExcalidrawExtension } from '../extensions/ExcalidrawExtension'

const lowlight = createLowlight(all)

// No-op suggestion config for Mention/noteLink — used only for schema, never triggered in read-only
const noopSuggestion = () => ({
  items: () => [] as { id: string; label: string }[],
  render: () => ({
    onStart: () => {},
    onUpdate: () => {},
    onKeyDown: () => false,
    onExit: () => {},
  }),
})

const NOTE_DISPLAY_EXTENSIONS: Extensions = [
  StarterKit.configure({
    codeBlock: false,
  }),
  CodeBlockLowlight.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        hideCode: { default: false, parseHTML: (el) => el.getAttribute('data-hide-code') === 'true', renderHTML: () => ({ 'data-hide-code': 'true' }) },
        mermaidTheme: { default: 'dark', parseHTML: (el) => el.getAttribute('data-mermaid-theme') ?? 'dark', renderHTML: () => ({ 'data-mermaid-theme': 'dark' }) },
        mermaidHeight: { default: null, parseHTML: () => null, renderHTML: () => {} },
      }
    },
  }).configure({ lowlight }),
  TextStyle,
  Color,
  Underline,
  Highlight.configure({ multicolor: false }),
  Superscript,
  Subscript,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Link.configure({ openOnClick: false }),
  Image.configure({ allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
  TaskList,
  TaskItem.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        actionId: { default: null, parseHTML: (el) => el.getAttribute('data-action-id') ?? null, renderHTML: (attrs) => (attrs.actionId ? { 'data-action-id': attrs.actionId } : {}) },
      }
    },
  }).configure({ nested: true }),
  Mention.extend({
    name: 'mention',
    addAttributes() {
      return {
        ...this.parent?.() ?? {},
        entityId: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-id') ?? el.getAttribute('data-entity-id'),
          renderHTML: (attrs) => (attrs.id ? { 'data-entity-id': attrs.id } : {}),
        },
        entityName: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-label') ?? el.getAttribute('data-entity-name'),
          renderHTML: (attrs) => (attrs.label ? { 'data-entity-name': attrs.label } : {}),
        },
      }
    },
  }).configure({ HTMLAttributes: { class: 'wizz-entity-chip' }, suggestion: noopSuggestion() }),
  Mention.extend({
    name: 'noteLink',
    addAttributes() {
      return {
        ...this.parent?.() ?? {},
        noteId: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-id') ?? el.getAttribute('data-note-id'),
          renderHTML: (attrs) => (attrs.id ? { 'data-note-id': attrs.id } : {}),
        },
        noteTitle: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-label') ?? el.getAttribute('data-note-title'),
          renderHTML: (attrs) => (attrs.label ? { 'data-note-title': attrs.label } : {}),
        },
      }
    },
  }).configure({ HTMLAttributes: { class: 'wizz-note-chip' }, suggestion: { char: '[[', ...noopSuggestion() } }),
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  Callout,
  ExcalidrawExtension,
]

/**
 * Convert a note's TipTap body JSON to HTML for read-only display.
 * Returns empty string if body is empty/invalid.
 */
export function noteBodyToHtml(body: string | undefined): string {
  if (!body || body === '{}') return ''
  let doc: JSONContent
  try {
    doc = JSON.parse(body) as JSONContent
  } catch {
    return ''
  }
  if (!doc || doc.type !== 'doc') return ''
  try {
    return generateHTML(doc, NOTE_DISPLAY_EXTENSIONS)
  } catch {
    return ''
  }
}
