<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { autocompletion } from '@codemirror/autocomplete'
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
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

// ── Autocomplete schema ───────────────────────────────────────────────────────

type EntityTypeSchema = { id: string; name: string; fields: string[] }
let entityTypes: EntityTypeSchema[] = []

function getCompletions(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context
  const textBefore = state.doc.sliceString(0, pos)

  // After FROM → suggest entity type names
  const fromMatch = /FROM\s+(\w*)$/i.exec(textBefore)
  if (fromMatch) {
    return {
      from: pos - fromMatch[1].length,
      options: entityTypes.map((t) => ({ label: t.name, type: 'type' })),
    }
  }

  // After alias. → suggest field names for that entity type
  const dotMatch = /(\w+)\.(\w*)$/.exec(textBefore)
  const aliasMatch = /SELECT\s+(\w+)\s+FROM\s+(\w+)/i.exec(textBefore)
  if (dotMatch && aliasMatch && dotMatch[1] === aliasMatch[1]) {
    const typeName = aliasMatch[2].toLowerCase()
    const fields = entityTypes.find((t) => t.name.toLowerCase() === typeName)?.fields ?? []
    return {
      from: pos - dotMatch[2].length,
      options: fields.map((f) => ({ label: f, type: 'property' })),
    }
  }

  // After a comparison operator → suggest {this}
  if (/(?:WHERE|AND|OR)\s+\S+\s*(?:!=|<=|>=|=|<|>|CONTAINS)\s*\{?$/i.test(textBefore)) {
    const from = textBefore.endsWith('{') ? pos - 1 : pos
    return {
      from,
      options: [{ label: '{this}', type: 'keyword' }],
    }
  }

  return null
}

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
    // ── Autocomplete dropdown ──────────────────────────────────────────────────
    '.cm-tooltip': {
      border: '1px solid var(--color-border)',
      borderRadius: '5px',
      overflow: 'hidden',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul': {
      background: 'var(--color-surface)',
      fontFamily: "ui-monospace, 'Cascadia Code', 'Fira Code', monospace",
      fontSize: '12px',
      maxHeight: '160px',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
      padding: '4px 10px',
      color: 'var(--color-text)',
    },
    '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'rgba(91, 141, 239, 0.25)',
      color: 'var(--color-text)',
    },
    '.cm-completionIcon': {
      display: 'none',
    },
    '.cm-completionDetail': {
      color: 'var(--color-text-muted)',
      fontStyle: 'normal',
      marginLeft: '6px',
    },
  },
  { dark: true },
)

// ── Editor lifecycle ──────────────────────────────────────────────────────────

onMounted(async () => {
  if (!containerRef.value) return

  // Fetch entity type schemas for autocomplete before creating the editor
  entityTypes = (await window.api.invoke(
    'entity-types:schema-for-autocomplete',
  )) as EntityTypeSchema[]

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      wqlLanguage(),
      syntaxHighlighting(wqlHighlight),
      wqlTheme,
      EditorView.lineWrapping,
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      autocompletion({ override: [getCompletions], activateOnTyping: true }),
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
