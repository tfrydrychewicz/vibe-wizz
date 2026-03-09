<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { PencilRuler, Pencil, Maximize2, X, Check, Loader2, Sparkles } from 'lucide-vue-next'
import {
  loadExcalidraw,
  consumeExcalidrawAutoOpen,
  type ReactRoot,
  type ExcalidrawElement,
  type OrderedExcalidrawElement,
  type AppState,
  type BinaryFiles,
} from '../utils/excalidrawLoader'

const props = defineProps(nodeViewProps)

// ─── Computed attrs ───────────────────────────────────────────────────────────

const previewSvg  = computed(() => props.node.attrs.previewSvg as string)
const hasDrawing  = computed(() => !!previewSvg.value)
const drawingHeight = computed(() => props.node.attrs.drawingHeight as number | null)

// ─── Edit modal state ─────────────────────────────────────────────────────────

const isEditing  = ref(false)
const isSaving   = ref(false)
const isLoading  = ref(false)

// React root and the imperatively-created canvas container.
// We do NOT use a Vue ref for the canvas — we create the DOM node ourselves
// after Excalidraw loads, so there are no Teleport / nextTick / scoped-CSS
// timing issues at all.
let reactRoot:         ReactRoot | null      = null
let excalidrawContainer: HTMLDivElement | null = null

let pendingElements: readonly OrderedExcalidrawElement[] = []
let pendingAppState: AppState | null = null
let pendingFiles:    BinaryFiles     = {}

// ─── AI Generate state ────────────────────────────────────────────────────────

const isGenerating    = ref(false)
const generatePrompt  = ref('')
const generateError   = ref<string | null>(null)
const showGenerateBox = ref(false)
const generateInputRef = ref<HTMLTextAreaElement | null>(null)

function openGenerateBox(): void {
  generatePrompt.value  = ''
  generateError.value   = null
  showGenerateBox.value = true
  void nextTick(() => generateInputRef.value?.focus())
}

function closeGenerateBox(): void {
  showGenerateBox.value = false
  generateError.value   = null
  isGenerating.value    = false
}

async function generateDiagram(): Promise<void> {
  const prompt = generatePrompt.value.trim()
  if (!prompt) return

  isGenerating.value  = true
  generateError.value = null

  const result = await (window.api.invoke('excalidraw:generate', { prompt }) as Promise<
    { elements: string; appState: string } | { error: string }
  >)

  isGenerating.value = false

  if ('error' in result) {
    generateError.value = result.error
    return
  }

  closeGenerateBox()
  await openEditModal({ elementsJson: result.elements, appStateJson: result.appState })
}

// ─── Edit modal ───────────────────────────────────────────────────────────────

interface InitialData {
  elementsJson: string
  appStateJson: string
}

/** Create a full-screen container below the modal header and mount React into it. */
async function openEditModal(initial?: InitialData): Promise<void> {
  isEditing.value = true
  isLoading.value = true

  const excalidraw = await loadExcalidraw()

  if (!isEditing.value) { isLoading.value = false; return }

  // Parse stored scene data (or use AI-generated initial data).
  let initialElements: ExcalidrawElement[] = []
  let initialAppState: Partial<AppState>   = {}
  let initialFiles:    BinaryFiles         = {}
  const elSrc  = initial?.elementsJson ?? props.node.attrs.elements as string
  const asSrc  = initial?.appStateJson ?? props.node.attrs.appState  as string
  try { initialElements = JSON.parse(elSrc)                          } catch { /* empty */ }
  try { initialAppState = JSON.parse(asSrc)                          } catch { /* empty */ }
  try { initialFiles    = JSON.parse(props.node.attrs.files as string)} catch { /* empty */ }

  pendingElements = initialElements as unknown as OrderedExcalidrawElement[]
  pendingAppState = null
  pendingFiles    = initialFiles

  // Create a plain DOM div and append it to body — no Vue scoped-CSS, no
  // Teleport timing, no nextTick. The container sits below the header (44 px).
  const container = document.createElement('div')
  container.style.cssText = [
    'position:fixed',
    'top:44px',
    'left:0',
    'right:0',
    'bottom:0',
    'z-index:1199',
    'background:#1a1a1a',
    'overflow:hidden',
  ].join(';')
  document.body.appendChild(container)
  excalidrawContainer = container

  const { ExcalidrawComponent, createElement, createRoot } = excalidraw

  reactRoot = createRoot(container)
  reactRoot.render(
    createElement(ExcalidrawComponent, {
      initialData: {
        elements:  initialElements,
        // collaborators must be a Map in Excalidraw 0.17+.
        // JSON.parse turns a serialized Map back into a plain {}, so we always
        // override it with an empty Map to prevent "forEach is not a function".
        appState:  { ...initialAppState, theme: 'dark', collaborators: new Map() },
        files:     initialFiles,
      },
      theme: 'dark',
      onChange: (
        els: readonly OrderedExcalidrawElement[],
        state: AppState,
        files: BinaryFiles,
      ) => {
        pendingElements = els
        pendingAppState = state
        pendingFiles    = files
      },
    }),
  )

  isLoading.value = false
}

async function saveAndClose(): Promise<void> {
  isSaving.value = true
  try {
    const { exportToSvg } = await loadExcalidraw()

    const svgEl = await exportToSvg({
      elements:  pendingElements as unknown as ExcalidrawElement[],
      // exportBackground: false → transparent SVG; the block's surface color shows through.
      appState:  { ...(pendingAppState ?? {}), exportBackground: false },
      files:     Object.keys(pendingFiles).length ? pendingFiles : null,
      exportPadding: 16,
    })
    const svgString = new XMLSerializer().serializeToString(svgEl)

    props.updateAttributes({
      elements:   JSON.stringify(pendingElements),
      appState:   JSON.stringify(pendingAppState ?? {}),
      files:      JSON.stringify(pendingFiles),
      previewSvg: svgString,
    })
  } finally {
    isSaving.value = false
    closeModal()
  }
}

function cancelEdit(): void {
  closeModal()
}

function closeModal(): void {
  reactRoot?.unmount()
  reactRoot = null
  excalidrawContainer?.remove()
  excalidrawContainer = null
  isEditing.value = false
}

// ─── Fullscreen lightbox ──────────────────────────────────────────────────────

const fullscreen = ref(false)

function openLightbox(): void  { fullscreen.value = true  }
function closeLightbox(): void { fullscreen.value = false }

// ─── Resize handle ────────────────────────────────────────────────────────────

const MIN_HEIGHT     = 120
const DEFAULT_HEIGHT = 280
const SCROLL_ZONE    = 80
const MAX_SCROLL_PX  = 14

const resizeHandleRef = ref<HTMLElement | null>(null)
const dragHeight      = ref<number | null>(null)
const isResizing      = ref(false)

const currentHeight = computed(() => dragHeight.value ?? drawingHeight.value)

function findScrollParent(el: Element): Element {
  let cur: Element | null = el.parentElement
  while (cur && cur !== document.documentElement) {
    const { overflowY } = window.getComputedStyle(cur)
    if (/auto|scroll/.test(overflowY)) return cur
    cur = cur.parentElement
  }
  return document.documentElement
}

function startResize(e: MouseEvent): void {
  e.preventDefault()
  isResizing.value = true

  const startY = e.clientY
  const startH = currentHeight.value ?? DEFAULT_HEIGHT
  const scrollEl: Element = resizeHandleRef.value
    ? findScrollParent(resizeHandleRef.value)
    : document.documentElement

  let lastClientY = e.clientY
  let rafId: number | null = null

  function tick(): void {
    const rect = scrollEl.getBoundingClientRect()
    const distBottom = rect.bottom - lastClientY
    const distTop    = lastClientY - rect.top
    if (distBottom < SCROLL_ZONE && distBottom > 0)
      scrollEl.scrollBy(0,  Math.ceil(MAX_SCROLL_PX * (1 - distBottom / SCROLL_ZONE)))
    else if (distTop < SCROLL_ZONE && distTop > 0)
      scrollEl.scrollBy(0, -Math.ceil(MAX_SCROLL_PX * (1 - distTop    / SCROLL_ZONE)))
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)

  function onMove(ev: MouseEvent): void {
    lastClientY = ev.clientY
    dragHeight.value = Math.max(MIN_HEIGHT, startH + (ev.clientY - startY))
  }
  function onUp(): void {
    isResizing.value = false
    if (rafId !== null) cancelAnimationFrame(rafId)
    if (dragHeight.value !== null) {
      props.updateAttributes({ drawingHeight: dragHeight.value })
      dragHeight.value = null
    }
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ─── Global keyboard handler ──────────────────────────────────────────────────

function onGlobalKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    if (fullscreen.value)      { closeLightbox();    return }
    if (isEditing.value)       { cancelEdit();       return }
    if (showGenerateBox.value) { closeGenerateBox(); return }
  }
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)

  // consumeExcalidrawAutoOpen() returns true (once) when the editor was just
  // inserted via the slash command. The flag lives in excalidrawLoader.ts
  // (session-only) so it is never written to the database.
  if (consumeExcalidrawAutoOpen()) {
    void openEditModal()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  // Safety: clean up React + DOM container if the TipTap node is deleted while modal is open.
  reactRoot?.unmount()
  reactRoot = null
  excalidrawContainer?.remove()
  excalidrawContainer = null
})
</script>

<template>
  <NodeViewWrapper class="excalidraw-block">

    <!-- ── Header ──────────────────────────────────────────────────────────── -->
    <div class="excalidraw-header" contenteditable="false">
      <span class="excalidraw-header-title">
        <PencilRuler :size="13" />
        Excalidraw Drawing
      </span>
      <div class="excalidraw-header-actions">
        <button
          v-if="hasDrawing"
          class="excalidraw-btn"
          title="View fullscreen"
          @click="openLightbox"
        >
          <Maximize2 :size="12" />
          View
        </button>
        <button class="excalidraw-btn excalidraw-btn--ai" title="Generate with AI" @click="openGenerateBox">
          <Sparkles :size="12" />
          Generate
        </button>
        <button class="excalidraw-btn excalidraw-btn--primary" title="Edit drawing" @click="openEditModal()">
          <Pencil :size="12" />
          Edit
        </button>
      </div>
    </div>

    <!-- ── Preview area ────────────────────────────────────────────────────── -->
    <div
      class="excalidraw-preview"
      :class="{ 'excalidraw-preview--resizing': isResizing, 'excalidraw-preview--sized': !!currentHeight }"
      :style="{ height: currentHeight ? currentHeight + 'px' : undefined }"
      contenteditable="false"
    >
      <!-- Empty state -->
      <div v-if="!hasDrawing" class="excalidraw-empty-state">
        <Pencil :size="32" class="excalidraw-empty-icon" />
        <span>Click <strong>Edit</strong> to start drawing</span>
      </div>

      <!-- SVG preview -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div
        v-else
        class="excalidraw-svg-preview"
        title="Click to expand"
        role="button"
        tabindex="0"
        @click="openLightbox"
        @keydown.enter="openLightbox"
        @keydown.space.prevent="openLightbox"
        v-html="previewSvg"
      />

      <!-- Resize handle -->
      <div ref="resizeHandleRef" class="preview-resize-handle" @mousedown="startResize">
        <div class="preview-resize-grip" />
      </div>
    </div>

  </NodeViewWrapper>

  <!-- ── AI Generate overlay ──────────────────────────────────────────────── -->
  <Teleport to="body">
    <Transition name="excalidraw-gen">
      <div
        v-if="showGenerateBox"
        class="excalidraw-gen-overlay"
        @click.self="closeGenerateBox"
      >
        <div class="excalidraw-gen-box" role="dialog" aria-label="Generate diagram with AI">
          <div class="excalidraw-gen-header">
            <Sparkles :size="14" />
            Generate Diagram with AI
          </div>
          <textarea
            ref="generateInputRef"
            v-model="generatePrompt"
            class="form-textarea excalidraw-gen-input"
            placeholder="Describe your diagram… e.g. 'User login flow with error handling' or 'Microservice architecture with API gateway, auth service, and database'"
            rows="4"
            :disabled="isGenerating"
            @keydown.enter.meta.prevent="generateDiagram"
            @keydown.esc.prevent="closeGenerateBox"
          />
          <div v-if="generateError" class="excalidraw-gen-error">
            ⚠ {{ generateError }}
          </div>
          <div class="excalidraw-gen-footer">
            <span class="excalidraw-gen-hint">⌘ Enter to generate · Esc to cancel</span>
            <div class="excalidraw-gen-actions">
              <button class="excalidraw-btn" :disabled="isGenerating" @click="closeGenerateBox">
                <X :size="12" />
                Cancel
              </button>
              <button
                class="excalidraw-btn excalidraw-btn--ai"
                :disabled="isGenerating || !generatePrompt.trim()"
                @click="generateDiagram"
              >
                <Loader2 v-if="isGenerating" :size="12" class="excalidraw-spinner" />
                <Sparkles v-else :size="12" />
                {{ isGenerating ? 'Generating…' : 'Generate' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>

  <!-- ── Edit modal header (Teleport to body) ─────────────────────────────── -->
  <!-- The Excalidraw canvas is created imperatively below the header (top:44px) -->
  <!-- so there are no Vue scoped-CSS / Teleport timing issues. -->
  <Teleport to="body">
    <div
      v-if="isEditing"
      class="excalidraw-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Excalidraw drawing editor"
    >
      <!-- Modal header -->
      <div class="excalidraw-modal-header" contenteditable="false">
        <span class="excalidraw-modal-title">
          <PencilRuler :size="15" />
          Edit Drawing
        </span>
        <div class="excalidraw-modal-actions">
          <div v-if="isLoading" class="excalidraw-loading-indicator">
            <Loader2 :size="13" class="excalidraw-spinner" />
            Loading…
          </div>
          <button class="excalidraw-btn" :disabled="isSaving || isLoading" @click="cancelEdit">
            <X :size="13" />
            Cancel
          </button>
          <button
            class="excalidraw-btn excalidraw-btn--save"
            :disabled="isSaving || isLoading"
            @click="saveAndClose"
          >
            <Loader2 v-if="isSaving" :size="13" class="excalidraw-spinner" />
            <Check v-else :size="13" />
            {{ isSaving ? 'Saving…' : 'Save & Close' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ── Fullscreen lightbox ───────────────────────────────────────────────── -->
  <Teleport to="body">
    <Transition name="excalidraw-lightbox">
      <div
        v-if="fullscreen"
        class="excalidraw-lightbox-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Excalidraw drawing fullscreen"
        @click.self="closeLightbox"
      >
        <button class="excalidraw-lightbox-close" aria-label="Close" @click="closeLightbox">
          <X :size="18" />
        </button>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="excalidraw-lightbox-svg" v-html="previewSvg" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* ── Block wrapper ──────────────────────────────────────────────────────────── */
.excalidraw-block {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  margin: 8px 0;
  overflow: hidden;
}

/* ── Header ─────────────────────────────────────────────────────────────────── */
.excalidraw-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(0, 0, 0, 0.15);
  gap: 8px;
}

.excalidraw-header-title {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  user-select: none;
}

.excalidraw-header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ── Shared small button ─────────────────────────────────────────────────────── */
.excalidraw-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  font-size: 11px;
  font-family: inherit;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-surface-raised);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
  flex-shrink: 0;
}

.excalidraw-btn:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-accent);
}

.excalidraw-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.excalidraw-btn--primary {
  color: var(--color-accent);
  border-color: rgba(91, 141, 239, 0.35);
}

.excalidraw-btn--primary:hover:not(:disabled) {
  background: rgba(91, 141, 239, 0.1);
  color: var(--color-accent-hover);
}

.excalidraw-btn--ai {
  color: #c084fc;
  border-color: rgba(192, 132, 252, 0.35);
}

.excalidraw-btn--ai:hover:not(:disabled) {
  background: rgba(192, 132, 252, 0.1);
  color: #d8b4fe;
  border-color: rgba(192, 132, 252, 0.6);
}

/* ── Preview area ────────────────────────────────────────────────────────────── */
.excalidraw-preview {
  position: relative;
  min-height: 140px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding-bottom: 14px; /* space for resize handle */
}

.excalidraw-preview--resizing {
  user-select: none;
}

.excalidraw-preview--sized {
  min-height: unset;
}

/* ── Empty state ─────────────────────────────────────────────────────────────── */
.excalidraw-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text-muted);
  font-size: 13px;
  padding: 24px;
  text-align: center;
  flex: 1;
}

.excalidraw-empty-icon {
  opacity: 0.3;
}

/* ── SVG preview ─────────────────────────────────────────────────────────────── */
.excalidraw-svg-preview {
  width: 100%;
  height: 100%;
  overflow: auto;
  cursor: zoom-in;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 16px 24px;
  transition: opacity 0.12s;
}

.excalidraw-svg-preview:hover {
  opacity: 0.85;
}

.excalidraw-svg-preview :deep(svg) {
  max-width: 100% !important;
  height: auto !important;
  display: block;
  /* Strip the white background Excalidraw bakes into exported SVGs so the
     block's own dark surface colour shows through instead. */
  background: transparent !important;
}

.excalidraw-preview--sized .excalidraw-svg-preview {
  height: 100%;
}

.excalidraw-preview--sized .excalidraw-svg-preview :deep(svg) {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
}

/* ── Resize handle (same pattern as CodeBlockView) ──────────────────────────── */
.preview-resize-handle {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 14px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity 0.15s;
}

.excalidraw-preview:hover .preview-resize-handle {
  opacity: 1;
}

.preview-resize-grip {
  width: 32px;
  height: 3px;
  border-radius: 2px;
  background: var(--color-border);
  transition: background 0.15s;
}

.preview-resize-handle:hover .preview-resize-grip {
  background: var(--color-text-muted);
}

/* ── Edit modal ──────────────────────────────────────────────────────────────── */
/* The overlay only holds the header bar (44 px tall). The canvas sits below   */
/* it in a plain DOM div created imperatively (z-index: 1199).                 */
.excalidraw-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1200;
  background: transparent;
  pointer-events: none; /* let clicks through to the React canvas below */
}

.excalidraw-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 8px 86px; /* 86px left = clear macOS traffic-light buttons */
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  height: 44px;
  box-sizing: border-box;
  gap: 12px;
  pointer-events: all; /* re-enable interaction on the header */
}

.excalidraw-modal-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}

.excalidraw-modal-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.excalidraw-btn--save {
  color: var(--color-success);
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.08);
}

.excalidraw-btn--save:hover:not(:disabled) {
  background: rgba(52, 211, 153, 0.15);
  color: var(--color-success);
  border-color: rgba(52, 211, 153, 0.5);
}

.excalidraw-loading-indicator {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-text-muted);
}

/* Spinner rotation */
.excalidraw-spinner {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Fullscreen lightbox ─────────────────────────────────────────────────────── */
.excalidraw-lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  flex-direction: column;
  padding: 52px 24px 24px;
  cursor: zoom-out;
}

.excalidraw-lightbox-close {
  position: absolute;
  top: 12px;
  right: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  z-index: 1;
}

.excalidraw-lightbox-close:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}

.excalidraw-lightbox-svg {
  flex: 1;
  min-height: 0;
  overflow: auto;
  cursor: default;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}

.excalidraw-lightbox-svg :deep(svg) {
  max-width: 100% !important;
  max-height: 100% !important;
  display: block;
  background: transparent !important;
}

/* ── AI Generate overlay ─────────────────────────────────────────────────────── */
.excalidraw-gen-overlay {
  position: fixed;
  inset: 0;
  z-index: 1300;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.excalidraw-gen-box {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  width: 100%;
  max-width: 520px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

.excalidraw-gen-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: #c084fc;
}

.excalidraw-gen-input {
  resize: vertical;
  min-height: 90px;
  font-size: 13px;
  line-height: 1.5;
}

.excalidraw-gen-error {
  font-size: 12px;
  color: var(--color-danger);
  background: var(--color-danger-subtle);
  border: 1px solid var(--color-danger-border);
  border-radius: 6px;
  padding: 6px 10px;
}

.excalidraw-gen-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.excalidraw-gen-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.excalidraw-gen-actions {
  display: flex;
  gap: 6px;
}

/* ── Transitions ─────────────────────────────────────────────────────────────── */
.excalidraw-gen-enter-active,
.excalidraw-gen-leave-active {
  transition: opacity 0.15s ease;
}
.excalidraw-gen-enter-from,
.excalidraw-gen-leave-to {
  opacity: 0;
}

.excalidraw-lightbox-enter-active,
.excalidraw-lightbox-leave-active {
  transition: opacity 0.18s ease;
}
.excalidraw-lightbox-enter-from,
.excalidraw-lightbox-leave-to {
  opacity: 0;
}
</style>
