<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { Chart } from 'chart.js'
import { NodeViewWrapper, NodeViewContent, nodeViewProps } from '@tiptap/vue-3'
import { ChevronDown, ChevronUp, Maximize2, X } from 'lucide-vue-next'
import { renderMermaid } from '../utils/mermaid'
import { renderChart } from '../utils/chartRenderer'

const props = defineProps(nodeViewProps)

// ─── Language list ───────────────────────────────────────────────────────────

const LANGUAGES = [
  { value: '',            label: 'Auto-detect' },
  { value: 'mermaid',    label: 'Mermaid (diagram)' },
  { value: 'chart',      label: 'Chart.js (chart)' },
  { value: 'bash',       label: 'Bash / Shell' },
  { value: 'c',          label: 'C' },
  { value: 'cpp',        label: 'C++' },
  { value: 'css',        label: 'CSS' },
  { value: 'diff',       label: 'Diff' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'go',         label: 'Go' },
  { value: 'graphql',    label: 'GraphQL' },
  { value: 'html',       label: 'HTML' },
  { value: 'java',       label: 'Java' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'json',       label: 'JSON' },
  { value: 'kotlin',     label: 'Kotlin' },
  { value: 'lua',        label: 'Lua' },
  { value: 'markdown',   label: 'Markdown' },
  { value: 'php',        label: 'PHP' },
  { value: 'plaintext',  label: 'Plain text' },
  { value: 'python',     label: 'Python' },
  { value: 'ruby',       label: 'Ruby' },
  { value: 'rust',       label: 'Rust' },
  { value: 'scss',       label: 'SCSS' },
  { value: 'sql',        label: 'SQL' },
  { value: 'swift',      label: 'Swift' },
  { value: 'toml',       label: 'TOML' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'xml',        label: 'XML' },
  { value: 'yaml',       label: 'YAML' },
]

// ─── Language select ──────────────────────────────────────────────────────────

const selectedLanguage = computed(() => props.node.attrs.language ?? '')
const isMermaid = computed(() => selectedLanguage.value === 'mermaid')
const isChart   = computed(() => selectedLanguage.value === 'chart')
// Whether the block has a live preview (either kind).
const hasPreview = computed(() => isMermaid.value || isChart.value)

function onLanguageChange(e: Event): void {
  props.updateAttributes({ language: (e.target as HTMLSelectElement).value || null })
}

// ─── Mermaid theme select ─────────────────────────────────────────────────────

const MERMAID_THEMES = [
  { value: 'dark',    label: 'Dark' },
  { value: 'default', label: 'Ocean' },
  { value: 'forest',  label: 'Forest' },
  { value: 'neutral', label: 'Slate' },
  { value: 'base',    label: 'Violet' },
]

const selectedTheme = computed(() => props.node.attrs.mermaidTheme ?? 'dark')

const THEME_BG: Record<string, string> = {
  dark:    '#242424',
  default: '#1a2035',
  forest:  '#0f1f0f',
  neutral: '#1c1c22',
  base:    '#1a1128',
}

const previewBg = computed(() => THEME_BG[selectedTheme.value] ?? '#242424')

function onThemeChange(e: Event): void {
  props.updateAttributes({ mermaidTheme: (e.target as HTMLSelectElement).value })
}

// ─── Hide-code toggle ─────────────────────────────────────────────────────────

const hideCode = computed(() => !!props.node.attrs.hideCode)
const hasError  = computed(() => !!mermaidError.value || !!chartError.value)

function toggleHideCode(): void {
  props.updateAttributes({ hideCode: !props.node.attrs.hideCode })
}

// ─── Mermaid rendering ────────────────────────────────────────────────────────

const mermaidId  = `mermaid-${Math.random().toString(36).slice(2)}`
const mermaidSvg   = ref('')
const mermaidError = ref('')
const mermaidBusy  = ref(false)

async function renderDiagram(): Promise<void> {
  if (!isMermaid.value) return
  const source = props.node.textContent?.trim()
  if (!source) {
    mermaidSvg.value   = ''
    mermaidError.value = ''
    return
  }

  mermaidBusy.value = true
  const result = await renderMermaid(mermaidId, source, selectedTheme.value)
  mermaidBusy.value = false

  if (result.error === null) {
    mermaidSvg.value   = result.svg
    mermaidError.value = ''
  } else {
    mermaidSvg.value   = ''
    mermaidError.value = result.error
  }
}

// ─── Chart rendering ──────────────────────────────────────────────────────────

const chartCanvasRef = ref<HTMLCanvasElement | null>(null)
const chartInstance  = ref<Chart | null>(null)
const chartError     = ref('')
const chartBusy      = ref(false)

async function renderChartBlock(): Promise<void> {
  if (!isChart.value) return
  const source = props.node.textContent?.trim()
  if (!source) {
    chartInstance.value?.destroy()
    chartInstance.value = null
    chartError.value = ''
    return
  }

  // Wait for canvas to be in the DOM.
  await nextTick()
  if (!chartCanvasRef.value) return

  chartBusy.value = true
  const result = renderChart(chartCanvasRef.value, source, chartInstance.value)
  chartBusy.value = false

  if (result.error === null) {
    chartInstance.value = result.chart
    chartError.value = ''
  } else {
    chartInstance.value = null
    chartError.value = result.error
  }
}

// ─── Shared debounce for both renderers ───────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduledRender(): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    if (isMermaid.value) void renderDiagram()
    else if (isChart.value) void renderChartBlock()
  }, 400)
}

watch(() => props.node.textContent, scheduledRender)
watch(isMermaid, (val) => { if (val) void renderDiagram() })
watch(isChart,   (val) => { if (val) void renderChartBlock() })
watch(selectedTheme, () => { if (isMermaid.value) scheduledRender() })

onMounted(() => {
  if (isMermaid.value) void renderDiagram()
  else if (isChart.value) void renderChartBlock()
})

// ─── Resize handle ────────────────────────────────────────────────────────────

const MIN_PREVIEW_HEIGHT  = 80
const DEFAULT_PREVIEW_HEIGHT = 200
const SCROLL_ZONE  = 80
const MAX_SCROLL_PX = 14

// `mermaidHeight` attribute is reused for both mermaid and chart preview height.
const persistedHeight = computed(() => props.node.attrs.mermaidHeight as number | null)
const dragHeight = ref<number | null>(null)
const currentHeight = computed(() => dragHeight.value ?? persistedHeight.value)
const isResizing = ref(false)

const resizeHandleRef = ref<HTMLElement | null>(null)

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
  const startH = currentHeight.value ?? DEFAULT_PREVIEW_HEIGHT

  const scrollEl: Element = resizeHandleRef.value
    ? findScrollParent(resizeHandleRef.value)
    : document.documentElement

  let lastClientY = e.clientY
  let rafId: number | null = null

  function tick(): void {
    const rect = scrollEl.getBoundingClientRect()
    const distBottom = rect.bottom - lastClientY
    const distTop    = lastClientY - rect.top

    if (distBottom < SCROLL_ZONE && distBottom > 0) {
      scrollEl.scrollBy(0, Math.ceil(MAX_SCROLL_PX * (1 - distBottom / SCROLL_ZONE)))
    } else if (distTop < SCROLL_ZONE && distTop > 0) {
      scrollEl.scrollBy(0, -Math.ceil(MAX_SCROLL_PX * (1 - distTop / SCROLL_ZONE)))
    }
    rafId = requestAnimationFrame(tick)
  }
  rafId = requestAnimationFrame(tick)

  function onMove(ev: MouseEvent): void {
    lastClientY = ev.clientY
    dragHeight.value = Math.max(MIN_PREVIEW_HEIGHT, startH + (ev.clientY - startY))

    // After resizing the container, tell Chart.js to re-layout.
    if (isChart.value) chartInstance.value?.resize()
  }

  function onUp(): void {
    isResizing.value = false
    if (rafId !== null) cancelAnimationFrame(rafId)
    if (dragHeight.value !== null) {
      props.updateAttributes({ mermaidHeight: dragHeight.value })
      dragHeight.value = null
    }
    window.removeEventListener('mousemove', onMove)
    window.removeEventListener('mouseup', onUp)
  }

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
}

// ─── Fullscreen lightbox (Mermaid only) ───────────────────────────────────────

const fullscreen = ref(false)
const mermaidFsId   = `${mermaidId}-fs`
const fullscreenSvg = computed(() =>
  mermaidSvg.value ? mermaidSvg.value.replaceAll(mermaidId, mermaidFsId) : ''
)

function openFullscreen(): void  { fullscreen.value = true  }
function closeFullscreen(): void { fullscreen.value = false }

function onOverlayKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closeFullscreen()
}

function onGlobalKeydown(e: KeyboardEvent): void {
  if (fullscreen.value && e.key === 'Escape') closeFullscreen()
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  chartInstance.value?.destroy()
})
</script>

<template>
  <NodeViewWrapper class="code-block-view">

    <!-- Header ──────────────────────────────────────────────────────────── -->
    <div
      class="code-block-header"
      :class="{ 'code-block-header--seamless': hasPreview && hideCode && !hasError }"
      contenteditable="false"
    >
      <!-- Left: hide/show toggle (mermaid or chart) -->
      <button
        v-if="hasPreview"
        class="code-block-hide-toggle"
        :disabled="hasError"
        :title="hasError ? 'Fix the error before hiding the code' : undefined"
        @click="toggleHideCode"
      >
        <component :is="hideCode ? ChevronDown : ChevronUp" :size="11" />
        {{ hideCode ? 'Show code' : 'Hide code' }}
      </button>
      <span v-else class="code-block-header-spacer" />

      <!-- Theme select (mermaid only) -->
      <select
        v-if="isMermaid"
        :value="selectedTheme"
        class="code-block-lang-select"
        @change="onThemeChange"
      >
        <option v-for="t in MERMAID_THEMES" :key="t.value" :value="t.value">
          {{ t.label }}
        </option>
      </select>

      <!-- Language select -->
      <select
        :value="selectedLanguage"
        class="code-block-lang-select"
        @change="onLanguageChange"
      >
        <option v-for="lang in LANGUAGES" :key="lang.value" :value="lang.value">
          {{ lang.label }}
        </option>
      </select>
    </div>

    <!-- Code ────────────────────────────────────────────────────────────── -->
    <pre v-show="!hasPreview || !hideCode || hasError"><NodeViewContent as="code" /></pre>

    <!-- Mermaid preview ─────────────────────────────────────────────────── -->
    <div
      v-if="isMermaid"
      class="preview-pane"
      :class="{
        'preview-pane--resizing': isResizing,
        'preview-pane--sized': !!currentHeight,
      }"
      :style="{
        background: previewBg,
        height: currentHeight ? currentHeight + 'px' : undefined,
      }"
      contenteditable="false"
    >
      <div v-if="mermaidBusy && !mermaidSvg && !mermaidError" class="preview-hint">
        Rendering diagram…
      </div>
      <div v-else-if="!mermaidSvg && !mermaidError && !mermaidBusy" class="preview-hint">
        Start typing Mermaid code above to preview the diagram.
      </div>
      <div
        v-else-if="mermaidSvg"
        class="mermaid-svg"
        title="Click to expand"
        role="button"
        tabindex="0"
        @click="openFullscreen"
        @keydown.enter="openFullscreen"
        @keydown.space.prevent="openFullscreen"
        v-html="mermaidSvg"
      />
      <div v-else-if="mermaidError" class="preview-error">
        <span class="preview-error-icon">⚠</span>
        <pre class="preview-error-text">{{ mermaidError }}</pre>
      </div>

      <div ref="resizeHandleRef" class="preview-resize-handle" @mousedown="startResize">
        <div class="preview-resize-grip" />
      </div>
    </div>

    <!-- Chart preview ───────────────────────────────────────────────────── -->
    <div
      v-if="isChart"
      class="preview-pane preview-pane--chart"
      :class="{
        'preview-pane--resizing': isResizing,
        'preview-pane--sized': !!currentHeight,
      }"
      :style="{ height: currentHeight ? currentHeight + 'px' : undefined }"
      contenteditable="false"
    >
      <div v-if="chartBusy && !chartInstance && !chartError" class="preview-hint">
        Rendering chart…
      </div>
      <div v-else-if="!chartInstance && !chartError && !chartBusy" class="preview-hint">
        Start typing a Chart.js JSON config above to preview the chart.
      </div>
      <div v-if="chartError" class="preview-error">
        <span class="preview-error-icon">⚠</span>
        <pre class="preview-error-text">{{ chartError }}</pre>
      </div>
      <!-- Canvas is always rendered (hidden via v-show) so chartInstance can reference it -->
      <canvas
        ref="chartCanvasRef"
        v-show="!!chartInstance && !chartError"
        class="chart-canvas"
      />

      <div ref="resizeHandleRef" class="preview-resize-handle" @mousedown="startResize">
        <div class="preview-resize-grip" />
      </div>
    </div>

  </NodeViewWrapper>

  <!-- Fullscreen lightbox (Mermaid only) ──────────────────────────────────── -->
  <Teleport to="body">
    <Transition name="mermaid-overlay">
      <div
        v-if="fullscreen"
        class="mermaid-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Mermaid diagram fullscreen"
        @click.self="closeFullscreen"
        @keydown="onOverlayKeydown"
      >
        <button class="mermaid-overlay-close" aria-label="Close" @click="closeFullscreen">
          <X :size="18" />
        </button>
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="mermaid-overlay-svg" :style="{ background: previewBg }" v-html="fullscreenSvg" />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.code-block-view {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  margin: 8px 0;
  overflow: hidden;
}

/* Header ------------------------------------------------------------------ */
.code-block-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 8px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(0, 0, 0, 0.15);
  gap: 8px;
}

.code-block-header--seamless {
  border-bottom: none;
}

.code-block-header-spacer {
  flex: 1;
}

/* Hide/show toggle --------------------------------------------------------- */
.code-block-hide-toggle {
  display: flex;
  align-items: center;
  gap: 3px;
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 3px;
  transition: color 0.12s, background 0.12s;
  flex-shrink: 0;
}

.code-block-hide-toggle:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-hover);
}

.code-block-hide-toggle:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Language select ---------------------------------------------------------- */
.code-block-lang-select {
  appearance: none;
  -webkit-appearance: none;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 1px 14px 1px 4px;
  outline: none;
  flex-shrink: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0 center;
  background-size: 10px;
}

.code-block-lang-select:hover {
  color: var(--color-text);
}

.code-block-lang-select option {
  background: var(--color-surface-raised);
  color: var(--color-text);
}

/* Code <pre> --------------------------------------------------------------- */
.code-block-view pre {
  background: none;
  border: none;
  border-radius: 0;
  padding: 12px 16px;
  margin: 0;
  overflow-x: auto;
}

.code-block-view pre :deep(code) {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-text);
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', monospace;
}

/* Shared preview pane ------------------------------------------------------ */
.preview-pane {
  position: relative;
  padding: 20px 24px 28px; /* bottom padding for resize handle */
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  min-height: 140px;
  border-top: 1px solid var(--color-border);
  overflow: hidden;
}

.preview-pane--chart {
  background: var(--color-surface);
  padding: 16px 16px 28px;
}

.preview-pane--resizing {
  user-select: none;
}

/* When the preview has an explicit height, make content fill it */
.preview-pane--sized .mermaid-svg,
.preview-pane--sized .chart-canvas {
  flex: 1;
  min-height: 0;
}

.preview-pane--sized .mermaid-svg :deep(svg) {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
}

/* Mermaid SVG --------------------------------------------------------------- */
.mermaid-svg {
  width: 100%;
  overflow-x: auto;
  cursor: zoom-in;
  border-radius: 4px;
  transition: opacity 0.12s;
  display: flex;
  justify-content: center;
  align-items: center;
}

.mermaid-svg:hover {
  opacity: 0.85;
}

.mermaid-svg :deep(svg) {
  max-width: 100% !important;
  height: auto !important;
  display: block;
}

/* Chart canvas ------------------------------------------------------------- */
.chart-canvas {
  width: 100% !important;
  height: 100% !important;
  display: block;
}

/* Shared preview messages -------------------------------------------------- */
.preview-hint {
  color: var(--color-text-muted);
  font-size: 12px;
  font-style: italic;
  align-self: center;
}

.preview-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--color-danger-subtle);
  border: 1px solid var(--color-danger-border);
  width: 100%;
}

.preview-error-icon {
  color: var(--color-danger);
  font-size: 14px;
  flex-shrink: 0;
  line-height: 1.4;
}

.preview-error-text {
  margin: 0;
  color: var(--color-danger);
  font-size: 12px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  white-space: pre-wrap;
  word-break: break-all;
  background: none;
  border: none;
  padding: 0;
}

/* Resize handle ------------------------------------------------------------ */
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

.preview-pane:hover .preview-resize-handle {
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

/* Fullscreen overlay ------------------------------------------------------- */
.mermaid-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: rgba(0, 0, 0, 0.9);
  display: flex;
  flex-direction: column;
  padding: 52px 24px 24px;
  cursor: zoom-out;
}

.mermaid-overlay-close {
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

.mermaid-overlay-close:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: rgba(255, 255, 255, 0.3);
}

.mermaid-overlay-svg {
  flex: 1;
  min-height: 0;
  overflow: auto;
  cursor: default;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
}

.mermaid-overlay-svg :deep(svg) {
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 100% !important;
  display: block;
}

.mermaid-overlay-enter-active,
.mermaid-overlay-leave-active {
  transition: opacity 0.18s ease;
}

.mermaid-overlay-enter-from,
.mermaid-overlay-leave-to {
  opacity: 0;
}
</style>
