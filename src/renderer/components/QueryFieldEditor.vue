<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { wqlLanguage } from '../lib/wql-language'

const props = defineProps<{
  modelValue: string
  placeholder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let view: EditorView | null = null

// ── WQL syntax highlight colours (Wizz dark palette) ─────────────────────────

const wqlHighlight = HighlightStyle.define([
  { tag: tags.keyword,      color: '#c792ea' }, // purple  — SELECT FROM WHERE …
  { tag: tags.atom,         color: '#f78c6c' }, // orange  — {this}
  { tag: tags.operator,     color: '#89ddff' }, // cyan    — = != < > <= >=
  { tag: tags.string,       color: '#c3e88d' }, // green   — 'string literal'
  { tag: tags.number,       color: '#f78c6c' }, // orange  — 42
  { tag: tags.variableName, color: '#e8e8e8' }, // default — alias / field names
  { tag: tags.punctuation,  color: '#666'    }, // muted   — dot
])

// ── CodeMirror theme (Wizz dark) ─────────────────────────────────────────────

const wqlTheme = EditorView.theme(
  {
    '&': {
      background: 'var(--color-bg)',
      border: '1px solid var(--color-border)',
      borderRadius: '5px',
      fontSize: '12px',
      fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
    },
    '&.cm-focused': {
      outline: 'none',
      borderColor: 'var(--color-accent)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      maxHeight: '120px',
      lineHeight: '1.5',
    },
    '.cm-content': {
      padding: '7px 10px',
      minHeight: '38px',
      caretColor: 'var(--color-accent)',
      color: 'var(--color-text)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-accent)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      background: 'rgba(91, 141, 239, 0.25)',
    },
    '&.cm-focused .cm-matchingBracket': {
      background: 'rgba(91, 141, 239, 0.15)',
    },
    '.cm-placeholder': {
      color: 'var(--color-text-muted)',
      fontStyle: 'italic',
    },
  },
  { dark: true },
)

// ── Editor lifecycle ──────────────────────────────────────────────────────────

onMounted(() => {
  if (!containerRef.value) return

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      wqlLanguage(),
      syntaxHighlighting(wqlHighlight),
      wqlTheme,
      EditorView.lineWrapping,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit('update:modelValue', update.state.doc.toString())
        }
      }),
      cmPlaceholder(props.placeholder ?? 'SELECT p FROM Person WHERE p.team = {this}'),
    ],
  })

  view = new EditorView({ state, parent: containerRef.value })
})

onBeforeUnmount(() => {
  view?.destroy()
  view = null
})

// Sync external model changes into the editor (e.g. when editing an existing type)
watch(
  () => props.modelValue,
  (newVal) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (newVal === current) return
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: newVal },
    })
  },
)
</script>

<template>
  <div ref="containerRef" class="wql-editor" />
</template>

<style scoped>
.wql-editor {
  width: 100%;
  box-sizing: border-box;
}

/* Style the CM6 placeholder span to match the rest of the app */
.wql-editor :deep(.cm-placeholder) {
  color: var(--color-text-muted);
  font-style: italic;
}
</style>
