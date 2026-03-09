import type { Component } from 'vue'
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'
import CalloutView from '../components/CalloutView.vue'

export type CalloutType = 'info' | 'warning' | 'success' | 'danger' | 'tip'

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      calloutType: {
        default: 'info' as CalloutType,
        parseHTML: (el) => (el.getAttribute('data-callout-type') as CalloutType) || 'info',
        renderHTML: (attrs) => ({ 'data-callout-type': attrs.calloutType }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout-type]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'callout' }, HTMLAttributes), 0]
  },

  addNodeView() {
    return VueNodeViewRenderer(CalloutView as Component<NodeViewProps>)
  },

  addKeyboardShortcuts() {
    return {
      // Exit callout on Enter at end of empty last paragraph
      Enter: ({ editor }) => {
        const { state } = editor
        const { selection } = state
        const { empty, $anchor } = selection
        if (!empty) return false
        const parentNode = $anchor.node(-1)
        if (parentNode?.type !== editor.schema.nodes.callout) return false
        const isAtEnd = $anchor.parentOffset === $anchor.parent.content.size
        const isLastBlock = $anchor.index(-1) === parentNode.childCount - 1
        const isEmptyPara = $anchor.parent.type.name === 'paragraph' && $anchor.parent.content.size === 0
        if (isAtEnd && isLastBlock && isEmptyPara) {
          return editor.chain().liftEmptyBlock().run()
        }
        return false
      },
    }
  },
})
