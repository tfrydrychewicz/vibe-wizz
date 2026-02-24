/**
 * TipTap extension that decorates untagged entity name occurrences in the editor.
 * When the NER pipeline detects an entity in the note, any plain-text occurrence
 * of that entity's name gets wrapped in a <span class="auto-mention-suggestion">
 * which shows a hover popup offering to convert it to a proper @mention chip.
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { AutoDetection } from '../stores/autoMentionStore'
import {
  setHoveredAutoDetection,
  scheduleHideAutoDetection,
  cancelHideAutoDetection,
} from '../stores/autoMentionStore'

export type { AutoDetection }

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    autoMentionDecoration: {
      /** Replace the current set of NER detections, rebuilding all decorations. */
      setAutoDetections: (detections: AutoDetection[]) => ReturnType
    }
  }
}

interface PluginState {
  detections: AutoDetection[]
  decorations: DecorationSet
}

const pluginKey = new PluginKey<PluginState>('autoMentionDecoration')

/** Return all text-level document spans where entityName appears (case-insensitive). */
function findEntitySpans(
  doc: ProseMirrorNode,
  entityName: string
): { from: number; to: number }[] {
  const spans: { from: number; to: number }[] = []
  const searchLower = entityName.toLowerCase()
  const searchLen = entityName.length

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const textLower = node.text.toLowerCase()
    let idx = 0
    while (true) {
      const found = textLower.indexOf(searchLower, idx)
      if (found === -1) break
      spans.push({ from: pos + found, to: pos + found + searchLen })
      idx = found + 1
    }
  })

  return spans
}

/**
 * Build a DecorationSet for all detections in the current document.
 * Each span gets `data-entity-id`, `data-from`, `data-to` so the hover
 * handler can identify which entity was detected and where to insert.
 *
 * Decorations are rebuilt on every doc change so data-from/to stay current.
 */
function buildDecorations(doc: ProseMirrorNode, detections: AutoDetection[]): DecorationSet {
  if (!detections.length) return DecorationSet.empty
  const decos: Decoration[] = []

  for (const detection of detections) {
    const spans = findEntitySpans(doc, detection.entityName)
    for (const { from, to } of spans) {
      decos.push(
        Decoration.inline(from, to, {
          class: 'auto-mention-suggestion',
          'data-entity-id': detection.entityId,
          'data-from': String(from),
          'data-to': String(to),
        })
      )
    }
  }

  return DecorationSet.create(doc, decos)
}

export const AutoMentionDecoration = Extension.create({
  name: 'autoMentionDecoration',

  addCommands() {
    return {
      setAutoDetections:
        (detections: AutoDetection[]) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            tr.setMeta(pluginKey, detections)
            dispatch(tr)
          }
          return true
        },
    }
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: pluginKey,

        state: {
          init(): PluginState {
            return { detections: [], decorations: DecorationSet.empty }
          },
          apply(tr, oldState): PluginState {
            const newDetections = tr.getMeta(pluginKey) as AutoDetection[] | undefined
            const detections = newDetections ?? oldState.detections
            // Rebuild on new detection data or any doc change so data-from/to stay current
            if (newDetections !== undefined || tr.docChanged) {
              return { detections, decorations: buildDecorations(tr.doc, detections) }
            }
            return oldState
          },
        },

        props: {
          decorations(state) {
            return this.getState(state)?.decorations ?? DecorationSet.empty
          },

          handleDOMEvents: {
            mouseover(view, event) {
              const target = event.target as Element
              const el = target.closest?.('.auto-mention-suggestion') as HTMLElement | null

              if (!el) {
                // Schedule hide unless the pointer moved into the popup itself
                if (!target.closest?.('.auto-mention-popup')) {
                  scheduleHideAutoDetection()
                }
                return false
              }

              const entityId = el.dataset['entityId'] ?? ''
              const from = parseInt(el.dataset['from'] ?? '0', 10)
              const to = parseInt(el.dataset['to'] ?? '0', 10)

              const state = pluginKey.getState(view.state)
              const detection = state?.detections.find((d) => d.entityId === entityId)
              if (!detection) return false

              cancelHideAutoDetection()
              setHoveredAutoDetection({
                ...detection,
                from,
                to,
                anchorRect: el.getBoundingClientRect(),
              })
              return false
            },
          },
        },
      }),
    ]
  },
})
