import type { Component } from 'vue'
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer } from '@tiptap/vue-3'
import type { NodeViewProps } from '@tiptap/vue-3'
import ExcalidrawView from '../components/ExcalidrawView.vue'

/**
 * TipTap atom node that embeds an Excalidraw interactive drawing.
 *
 * The node is a leaf block (atom: true) — the user selects and deletes it as a
 * unit, like an image. All scene data is stored in node attributes; no
 * NodeViewContent is needed.
 *
 * Attributes:
 *   elements      – JSON.stringify(ExcalidrawElement[])   — scene elements
 *   appState      – JSON.stringify(Partial<AppState>)     — bg color, grid, etc.
 *   files         – JSON.stringify(BinaryFiles)           — embedded images
 *   previewSvg    – SVG markup string, regenerated on every save-from-edit
 *   drawingHeight – persisted preview pane height in px (null = default)
 *
 * Auto-open (opening the editor immediately after insertion) is handled via a
 * session flag in excalidrawLoader.ts — not a node attribute — so it is never
 * written to the database.
 */
export const ExcalidrawExtension = Node.create({
  name: 'excalidraw',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      elements: {
        default: '[]',
        parseHTML: (el) => el.getAttribute('data-elements') ?? '[]',
        renderHTML: (attrs) => ({ 'data-elements': attrs.elements }),
      },
      appState: {
        default: '{}',
        parseHTML: (el) => el.getAttribute('data-app-state') ?? '{}',
        renderHTML: (attrs) => ({ 'data-app-state': attrs.appState }),
      },
      files: {
        default: '{}',
        parseHTML: (el) => el.getAttribute('data-files') ?? '{}',
        renderHTML: (attrs) => ({ 'data-files': attrs.files }),
      },
      previewSvg: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-preview-svg') ?? '',
        renderHTML: (attrs) =>
          attrs.previewSvg ? { 'data-preview-svg': attrs.previewSvg } : {},
      },
      drawingHeight: {
        default: null,
        parseHTML: (el) => {
          const v = el.getAttribute('data-drawing-height')
          return v ? Number(v) : null
        },
        renderHTML: (attrs) =>
          attrs.drawingHeight != null
            ? { 'data-drawing-height': String(attrs.drawingHeight) }
            : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-excalidraw]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-excalidraw': '' }, HTMLAttributes)]
  },

  addNodeView() {
    return VueNodeViewRenderer(ExcalidrawView as Component<NodeViewProps>)
  },
})
