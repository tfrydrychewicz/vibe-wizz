<script setup lang="ts">
import { ref } from 'vue'
import { NOTE_SELECTION_MIME, type NoteSelectionAttachment } from '../types/noteSelection'
import InputEntityPicker from './InputEntityPicker.vue'
import InputNoteLinkPicker from './InputNoteLinkPicker.vue'
import { useEntityChips } from '../composables/useEntityChips'
import type { EntityResult } from '../composables/useInputMention'

interface NoteResult {
  id: string
  title: string
}

export interface RichInputContent {
  text: string
  /**
   * Display-only version of text that keeps selection chips inline via `WIZZSELnWIZZSEL`
   * positional markers (index into `selections`).  Never sent to the AI — use `text` for that.
   */
  displayContent: string
  mentionedEntityIds: string[]
  /** Full entity objects (id + name) for each unique mentioned entity, in order of first appearance. */
  mentionedEntities: { id: string; name: string }[]
  mentionedNoteIds: string[]
  /** Full note objects (id + title) for each unique linked note, in order of first appearance. */
  mentionedNotes: { id: string; title: string }[]
  selections: NoteSelectionAttachment[]
}

withDefaults(defineProps<{
  placeholder?: string
  disabled?: boolean
}>(), { placeholder: '', disabled: false })

const emit = defineEmits<{
  submit: []
  escape: []
  /** Delegate file/image paste events up to the parent for handling. */
  paste: [e: ClipboardEvent]
  change: []
}>()

const editorRef = ref<HTMLDivElement | null>(null)
const _isEmpty = ref(true)

// ── Entity chip color/icon — uses the canonical composable (same as chat bubbles) ──
const { applyAfterTick } = useEntityChips()

// ── Mention state ─────────────────────────────────────────────────────────────
const mentionActive = ref(false)
const mentionQuery = ref('')
const mentionResults = ref<EntityResult[]>([])
const mentionIndex = ref(0)
let mentionTimer: ReturnType<typeof setTimeout> | null = null

// ── Note-link state ────────────────────────────────────────────────────────────
const noteLinkActive = ref(false)
const noteLinkQuery = ref('')
const noteLinkResults = ref<NoteResult[]>([])
const noteLinkIndex = ref(0)
let noteLinkTimer: ReturnType<typeof setTimeout> | null = null

// ── Selection store: uuid → NoteSelectionAttachment ───────────────────────────
const selectionStore = new Map<string, NoteSelectionAttachment>()

// ── Cursor text helpers ───────────────────────────────────────────────────────

/**
 * Return the plain-text content between the last chip (or start of editor) and
 * the current cursor position. Used for trigger (@, [[) detection.
 */
function getTextBeforeCursor(): string {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return ''
  const range = sel.getRangeAt(0)

  if (range.startContainer.nodeType === Node.TEXT_NODE) {
    // Accumulate text in the current text segment, stopping at any element node
    let text = (range.startContainer.textContent ?? '').slice(0, range.startOffset)
    let node: ChildNode | null = range.startContainer.previousSibling
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) break
      if (node.nodeType === Node.TEXT_NODE) text = (node.textContent ?? '') + text
      node = node.previousSibling
    }
    return text
  }

  // Cursor between child nodes of the editor div itself
  if (range.startContainer === editorRef.value) {
    let text = ''
    let i = 0
    for (const child of Array.from(editorRef.value.childNodes)) {
      if (i >= range.startOffset) break
      if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? ''
      else text = '' // reset at element boundaries (chips, etc.)
      i++
    }
    return text
  }

  return ''
}

// ── Trigger detection ─────────────────────────────────────────────────────────

function updateTriggerState(): void {
  const text = getTextBeforeCursor()

  const atMatch = text.match(/@([^@\n]*)$/)
  if (atMatch) {
    const query = atMatch[1]
    const wasActive = mentionActive.value
    mentionActive.value = true
    closeNoteLink()
    // Fire search when newly activated (even with empty query) or when query changed
    if (!wasActive || query !== mentionQuery.value) {
      mentionQuery.value = query
      debouncedEntitySearch(query)
    }
    return
  }

  const llMatch = text.match(/\[\[([^\]\n]*)$/)
  if (llMatch) {
    const query = llMatch[1]
    const wasActive = noteLinkActive.value
    noteLinkActive.value = true
    closeMention()
    // Fire search when newly activated (even with empty query) or when query changed
    if (!wasActive || query !== noteLinkQuery.value) {
      noteLinkQuery.value = query
      debouncedNoteSearch(query)
    }
    return
  }

  closeMention()
  closeNoteLink()
}

function closeMention(): void {
  mentionActive.value = false
  mentionResults.value = []
  mentionQuery.value = ''
  mentionIndex.value = 0
  if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null }
}

function closeNoteLink(): void {
  noteLinkActive.value = false
  noteLinkResults.value = []
  noteLinkQuery.value = ''
  noteLinkIndex.value = 0
  if (noteLinkTimer) { clearTimeout(noteLinkTimer); noteLinkTimer = null }
}

// ── IPC searches ──────────────────────────────────────────────────────────────

function debouncedEntitySearch(query: string): void {
  if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null }
  mentionResults.value = []
  mentionIndex.value = 0
  mentionTimer = setTimeout(async () => {
    try {
      const results = await window.api.invoke('entities:search', { query }) as EntityResult[]
      mentionResults.value = results.slice(0, 8)
    } catch { mentionResults.value = [] }
  }, 150)
}

function debouncedNoteSearch(query: string): void {
  if (noteLinkTimer) { clearTimeout(noteLinkTimer); noteLinkTimer = null }
  noteLinkResults.value = []
  noteLinkIndex.value = 0
  noteLinkTimer = setTimeout(async () => {
    try {
      const results = await window.api.invoke('notes:search', { query }) as NoteResult[]
      noteLinkResults.value = results.slice(0, 8)
    } catch { noteLinkResults.value = [] }
  }, 150)
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

/** Delete `count` characters immediately before the cursor in its text node. */
function deleteTextBeforeCursor(count: number): void {
  if (count <= 0) return
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  if (range.startContainer.nodeType !== Node.TEXT_NODE) return
  const delRange = document.createRange()
  delRange.setStart(range.startContainer, Math.max(0, range.startOffset - count))
  delRange.setEnd(range.startContainer, range.startOffset)
  delRange.deleteContents()
}

/**
 * Insert a DOM node at the cursor position and place cursor after a trailing
 * space so the user can continue typing immediately.
 */
function insertNodeAtCursor(node: HTMLElement): void {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  range.collapse(true)
  range.insertNode(node)

  const space = document.createTextNode(' ')
  node.after(space)

  const afterRange = document.createRange()
  afterRange.setStart(space, 1)
  afterRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(afterRange)
  editorRef.value?.focus()
}

function makeChipBase(className: string): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.className = `rich-chip ${className}`
  return chip
}

function makeRemoveBtn(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = 'rich-chip__remove'
  btn.dataset.chipRemove = ''
  btn.type = 'button'
  btn.setAttribute('aria-label', 'Remove')
  btn.textContent = '×'
  return btn
}

// ── Chip insertion ────────────────────────────────────────────────────────────

function insertEntityChip(entity: EntityResult): void {
  if (!editorRef.value) return
  const triggerLen = mentionQuery.value.length + 1
  closeMention()
  deleteTextBeforeCursor(triggerLen)

  // wizz-entity-chip is the canonical class — useEntityChips will apply type color + icon
  const chip = makeChipBase('wizz-entity-chip')
  chip.dataset.entityId = entity.id
  chip.dataset.entityName = entity.name

  const label = document.createElement('span')
  label.textContent = `@${entity.name}`
  chip.appendChild(label)
  chip.appendChild(makeRemoveBtn())

  insertNodeAtCursor(chip)
  updateEmptyState()
  emit('change')

  // Apply type-matching color and icon (async, non-blocking)
  applyAfterTick(editorRef.value)
}

function insertNoteChip(note: NoteResult): void {
  if (!editorRef.value) return
  const triggerLen = noteLinkQuery.value.length + 2
  closeNoteLink()
  deleteTextBeforeCursor(triggerLen)

  const chip = makeChipBase('rich-chip--note')
  chip.dataset.noteId = note.id
  chip.dataset.noteTitle = note.title

  const label = document.createElement('span')
  label.textContent = `[[${note.title}]]`
  chip.appendChild(label)
  chip.appendChild(makeRemoveBtn())

  insertNodeAtCursor(chip)
  updateEmptyState()
  emit('change')
}

function insertSelectionChip(attachment: NoteSelectionAttachment): void {
  if (!editorRef.value) return
  const id = crypto.randomUUID()
  selectionStore.set(id, attachment)

  const chip = makeChipBase('rich-chip--selection')
  chip.dataset.selectionId = id

  const label = document.createElement('span')
  label.textContent = `${attachment.noteTitle} (${attachment.blockStart}–${attachment.blockEnd})`
  chip.appendChild(label)
  chip.appendChild(makeRemoveBtn())

  insertNodeAtCursor(chip)
  updateEmptyState()
  emit('change')
}

function removeChip(chip: HTMLElement): void {
  if (chip.dataset.selectionId) selectionStore.delete(chip.dataset.selectionId)
  // Also remove the trailing space that was inserted after the chip
  const next = chip.nextSibling
  if (next?.nodeType === Node.TEXT_NODE && next.textContent?.[0] === ' ') {
    if (next.textContent.length === 1) next.remove()
    else next.textContent = next.textContent.slice(1)
  }
  chip.remove()
  updateEmptyState()
  editorRef.value?.focus()
  emit('change')
}

// ── Empty state ───────────────────────────────────────────────────────────────

function updateEmptyState(): void {
  const el = editorRef.value
  if (!el) { _isEmpty.value = true; return }
  const hasChips = el.querySelector('[data-entity-id],[data-note-id],[data-selection-id]') !== null
  _isEmpty.value = !hasChips && (el.textContent?.trim() ?? '') === ''
}

// ── Event handlers ─────────────────────────────────────────────────────────────

function onInput(): void {
  updateTriggerState()
  updateEmptyState()
  emit('change')
}

/** Intercept mousedown on chip × buttons to remove them without changing cursor. */
function onMousedown(e: MouseEvent): void {
  const btn = (e.target as HTMLElement).closest('[data-chip-remove]') as HTMLElement | null
  if (!btn) return
  e.preventDefault()
  const chip = btn.parentElement as HTMLElement | null
  if (chip) removeChip(chip)
}

function onKeydown(e: KeyboardEvent): void {
  if (mentionActive.value) {
    if (e.key === 'Escape') { e.preventDefault(); closeMention(); return }
    if (mentionResults.value.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mentionIndex.value = (mentionIndex.value + 1) % mentionResults.value.length; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); mentionIndex.value = (mentionIndex.value - 1 + mentionResults.value.length) % mentionResults.value.length; return }
      if (e.key === 'Enter') { e.preventDefault(); const entity = mentionResults.value[mentionIndex.value]; if (entity) insertEntityChip(entity); return }
    }
  }

  if (noteLinkActive.value) {
    if (e.key === 'Escape') { e.preventDefault(); closeNoteLink(); return }
    if (noteLinkResults.value.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); noteLinkIndex.value = (noteLinkIndex.value + 1) % noteLinkResults.value.length; return }
      if (e.key === 'ArrowUp') { e.preventDefault(); noteLinkIndex.value = (noteLinkIndex.value - 1 + noteLinkResults.value.length) % noteLinkResults.value.length; return }
      if (e.key === 'Enter') { e.preventDefault(); const note = noteLinkResults.value[noteLinkIndex.value]; if (note) insertNoteChip(note); return }
    }
  }

  if (e.key === 'Escape') { emit('escape'); return }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); emit('submit'); return }
}

function onPaste(e: ClipboardEvent): void {
  // 1. Note selection (custom MIME type — created by NoteEditor copy handler)
  const raw = e.clipboardData?.getData(NOTE_SELECTION_MIME)
  if (raw) {
    try {
      const attachment = JSON.parse(raw) as NoteSelectionAttachment
      if (typeof attachment.noteId === 'string' && typeof attachment.selectedText === 'string') {
        e.preventDefault()
        insertSelectionChip(attachment)
        return
      }
    } catch { /* fall through */ }
  }

  // 2. Files / images: delegate to parent
  if ((e.clipboardData?.files.length ?? 0) > 0) {
    e.preventDefault()
    emit('paste', e)
    return
  }

  // 3. HTML paste: strip formatting, insert as plain text
  if (e.clipboardData?.types.includes('text/html')) {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
    return
  }

  // 4. Plain text: let browser handle naturally
}

function onBlur(): void {
  closeMention()
  closeNoteLink()
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Walk the editor's DOM tree and extract: plain text with @mentions and
 * [[notes]] inlined as their text representations, plus separate ID lists and
 * note-selection attachment objects.
 */
function getContent(): RichInputContent {
  const el = editorRef.value
  if (!el) return { text: '', displayContent: '', mentionedEntityIds: [], mentionedEntities: [], mentionedNoteIds: [], mentionedNotes: [], selections: [] }

  let text = ''
  let displayContent = ''
  const mentionedEntityIds: string[] = []
  const mentionedEntities: { id: string; name: string }[] = []
  const mentionedNoteIds: string[] = []
  const mentionedNotes: { id: string; title: string }[] = []
  const selections: NoteSelectionAttachment[] = []
  const seenEntityIds = new Set<string>()
  const seenNoteIds = new Set<string>()

  function walk(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      // Normalize non-breaking spaces inserted after chips to regular spaces
      const t = (node.textContent ?? '').replace(/\u00A0/g, ' ')
      text += t
      displayContent += t
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement
      if (el.dataset.entityId) {
        // Entity chip — add @Name to both strings, record ID + name (no recursion into children)
        const token = `@${el.dataset.entityName ?? ''}`
        text += token
        displayContent += token
        if (!seenEntityIds.has(el.dataset.entityId)) {
          seenEntityIds.add(el.dataset.entityId)
          mentionedEntityIds.push(el.dataset.entityId)
          mentionedEntities.push({ id: el.dataset.entityId, name: el.dataset.entityName ?? '' })
        }
      } else if (el.dataset.noteId) {
        // Note chip — add [[title]] to both strings
        const token = `[[${el.dataset.noteTitle ?? ''}]]`
        text += token
        displayContent += token
        if (!seenNoteIds.has(el.dataset.noteId)) {
          seenNoteIds.add(el.dataset.noteId)
          mentionedNoteIds.push(el.dataset.noteId)
          mentionedNotes.push({ id: el.dataset.noteId, title: el.dataset.noteTitle ?? '' })
        }
      } else if (el.dataset.selectionId) {
        // Selection chip — no text for AI, but inject a positional marker in displayContent
        const att = selectionStore.get(el.dataset.selectionId)
        if (att) {
          displayContent += `WIZZSEL${selections.length}WIZZSEL`
          selections.push(att)
        }
      } else if (el.tagName === 'BR') {
        text += '\n'
        displayContent += '\n'
      } else if (el.tagName === 'DIV' || el.tagName === 'P') {
        if (text.length > 0 && !text.endsWith('\n')) { text += '\n'; displayContent += '\n' }
        for (const child of Array.from(el.childNodes)) walk(child)
      } else {
        // Recurse into other elements (spans without chip data-attrs, etc.)
        for (const child of Array.from(el.childNodes)) walk(child)
      }
    }
  }

  for (const child of Array.from(el.childNodes)) walk(child)

  return { text: text.trim(), displayContent: displayContent.trim(), mentionedEntityIds, mentionedEntities, mentionedNoteIds, mentionedNotes, selections }
}

function clear(): void {
  if (editorRef.value) editorRef.value.innerHTML = ''
  selectionStore.clear()
  _isEmpty.value = true
  closeMention()
  closeNoteLink()
  emit('change')
}

/**
 * Restore the editor from saved HTML (e.g. from a persisted settings value).
 * Re-applies entity chip colors/icons after setting the content.
 * Note: selection chips cannot be restored (their data lives only in memory),
 * but entity and note chips are fully restored from data-* attributes.
 */
function setContent(html: string): void {
  if (!editorRef.value) return
  editorRef.value.innerHTML = html
  updateEmptyState()
  applyAfterTick(editorRef.value)
}

/** Return the raw innerHTML of the editor for persistence. */
function getHtml(): string {
  return editorRef.value?.innerHTML ?? ''
}

function focus(): void {
  editorRef.value?.focus()
}

function isEmpty(): boolean {
  return _isEmpty.value
}

defineExpose({ getContent, getHtml, setContent, clear, focus, isEmpty })
</script>

<template>
  <div class="rich-input-wrap">
    <!-- Pickers float above the input, positioned relative to this wrapper -->
    <InputEntityPicker
      v-if="mentionActive && mentionResults.length > 0"
      :items="mentionResults"
      :active-index="mentionIndex"
      @pick="insertEntityChip"
    />
    <InputNoteLinkPicker
      v-if="noteLinkActive && noteLinkResults.length > 0"
      :items="noteLinkResults"
      :active-index="noteLinkIndex"
      @pick="insertNoteChip"
    />

    <!-- Contenteditable editor -->
    <div
      ref="editorRef"
      class="rich-input"
      :contenteditable="disabled ? 'false' : 'true'"
      role="textbox"
      aria-multiline="true"
      spellcheck="true"
      :aria-disabled="disabled"
      @input="onInput"
      @keydown="onKeydown"
      @mousedown="onMousedown"
      @paste="onPaste"
      @blur="onBlur"
    />

    <!-- Placeholder overlay (CSS :empty doesn't reliably work on contenteditable) -->
    <div
      v-if="_isEmpty && placeholder"
      class="rich-input-placeholder"
      aria-hidden="true"
    >
      {{ placeholder }}
    </div>
  </div>
</template>

<style scoped>
.rich-input-wrap {
  position: relative;
  flex: 1;
  min-width: 0;
}

.rich-input {
  width: 100%;
  min-height: 36px;
  max-height: 120px;
  overflow-y: auto;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  color: var(--color-text);
  outline: none;
  box-sizing: border-box;
  word-break: break-word;
  white-space: pre-wrap;
  /* All visual chrome supplied by the parent via CSS variables */
  background: var(--rich-input-bg, var(--color-surface));
  border: var(--rich-input-border, 1px solid var(--color-border));
  border-radius: var(--rich-input-radius, 8px);
  transition: border-color 0.1s;
}

.rich-input:focus {
  border-color: var(--color-accent);
}

.rich-input[contenteditable='false'] {
  opacity: 0.5;
  cursor: not-allowed;
}

.rich-input-placeholder {
  position: absolute;
  top: 8px;
  left: 10px;
  right: 10px;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  color: var(--color-text-muted);
  pointer-events: none;
  user-select: none;
  white-space: pre-wrap;
}
</style>
