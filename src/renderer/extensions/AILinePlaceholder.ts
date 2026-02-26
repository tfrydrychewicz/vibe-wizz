/**
 * TipTap extension that shows a subtle "Type space for AI" hint
 * on the currently focused empty paragraph — but only when the editor
 * has other content (so it doesn't conflict with TipTap's built-in
 * "Start writing…" placeholder on a blank note).
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

const aiLinePlaceholderKey = new PluginKey('aiLinePlaceholder')

export const AILinePlaceholder = Extension.create({
  name: 'aiLinePlaceholder',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: aiLinePlaceholderKey,
        props: {
          decorations(state) {
            const { selection, doc } = state
            const { $from, empty } = selection

            // Only for collapsed cursors
            if (!empty) return DecorationSet.empty
            // Only inside paragraphs
            if ($from.parent.type.name !== 'paragraph') return DecorationSet.empty
            // Only if the paragraph is completely empty
            if ($from.parent.textContent !== '') return DecorationSet.empty
            // Don't show when the whole doc is just one empty paragraph
            // (TipTap's Placeholder already handles "Start writing…" there)
            if (doc.childCount === 1) return DecorationSet.empty

            const from = $from.before()
            const to = from + $from.parent.nodeSize
            const deco = Decoration.node(from, to, { class: 'has-ai-line-hint' })
            return DecorationSet.create(doc, [deco])
          },
        },
      }),
    ]
  },
})
