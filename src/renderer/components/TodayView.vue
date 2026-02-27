<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ChevronLeft, ChevronRight, RefreshCw, Sparkles } from 'lucide-vue-next'
import type { OpenMode } from '../stores/tabStore'

// ── Types ────────────────────────────────────────────────────────────────────

interface DailyBrief {
  id: number
  date: string
  content: string
  calendar_snapshot: string
  pending_actions_snapshot: string
  generated_at: string
  acknowledged_at: string | null
}

const emit = defineEmits<{
  'open-entity': [{ entityId: string; typeId?: string; mode: OpenMode }]
  'open-note':   [{ noteId: string; title: string; mode: OpenMode }]
}>()

// ── State ────────────────────────────────────────────────────────────────────

const todayDate = getLocalDate(new Date())
const currentDate = ref(todayDate)

const brief = ref<DailyBrief | null>(null)
const loading = ref(false)
const generating = ref(false)
const error = ref<string | null>(null)

// ── Helpers ──────────────────────────────────────────────────────────────────

function getLocalDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function shiftDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T12:00:00`)
  d.setDate(d.getDate() + days)
  return getLocalDate(d)
}

function formatDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00`)
  return d.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

// ── Computed ─────────────────────────────────────────────────────────────────

const isToday = computed(() => currentDate.value === todayDate)
const isFuture = computed(() => currentDate.value > todayDate)

const dateTitle = computed(() => formatDate(currentDate.value))

const renderedBrief = computed((): string => {
  if (!brief.value?.content) return ''
  return markdownToHtml(brief.value.content)
})

// ── Navigation ────────────────────────────────────────────────────────────────

function goBack(): void {
  currentDate.value = shiftDate(currentDate.value, -1)
}

function goForward(): void {
  if (!isToday.value) currentDate.value = shiftDate(currentDate.value, 1)
}

function goToToday(): void {
  currentDate.value = todayDate
}

// ── Data loading ─────────────────────────────────────────────────────────────

async function loadBrief(): Promise<void> {
  loading.value = true
  error.value = null
  brief.value = null
  try {
    const result = (await window.api.invoke('daily-briefs:get', { date: currentDate.value })) as DailyBrief | null
    brief.value = result
    if (result && !result.acknowledged_at && currentDate.value === todayDate) {
      window.api.invoke('daily-briefs:acknowledge', { date: currentDate.value }).catch(() => { /* non-critical */ })
      brief.value = { ...result, acknowledged_at: new Date().toISOString() }
    }
  } catch (err) {
    console.error('[TodayView] loadBrief error:', err)
  } finally {
    loading.value = false
  }
}

async function generate(): Promise<void> {
  generating.value = true
  error.value = null
  const dateAtStart = currentDate.value
  try {
    const result = (await window.api.invoke('daily-briefs:generate', { date: dateAtStart })) as
      | DailyBrief
      | { error: string }
      | null
    // Only apply result if the user hasn't navigated away during generation
    if (currentDate.value !== dateAtStart) return
    if (result && 'error' in result) {
      error.value = result.error
    } else {
      brief.value = result as DailyBrief | null
      if (brief.value && !brief.value.acknowledged_at) {
        window.api.invoke('daily-briefs:acknowledge', { date: dateAtStart }).catch(() => { /* non-critical */ })
        brief.value = { ...brief.value, acknowledged_at: new Date().toISOString() }
      }
    }
  } catch {
    if (currentDate.value === dateAtStart) {
      error.value = 'Something went wrong. Please try again.'
    }
  } finally {
    if (currentDate.value === dateAtStart) generating.value = false
  }
}

// ── Watch date ────────────────────────────────────────────────────────────────

watch(currentDate, () => {
  generating.value = false
  loadBrief()
}, { immediate: true })

// ── Brief click delegation ────────────────────────────────────────────────────

async function onBriefClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'

  const entityBtn = target.closest('[data-entity-name]') as HTMLElement | null
  if (entityBtn) {
    const name = entityBtn.dataset.entityName
    if (!name) return
    try {
      const rows = await window.api.invoke('entities:search', { query: name }) as { id: string; name: string; type_id: string }[]
      const entity = rows.find((r) => r.name.toLowerCase() === name.toLowerCase())
      if (entity) emit('open-entity', { entityId: entity.id, mode })
    } catch { /* not found — no-op */ }
    return
  }

  const noteBtn = target.closest('[data-note-title]') as HTMLElement | null
  if (!noteBtn) return
  const title = noteBtn.dataset.noteTitle
  if (!title) return
  try {
    const rows = await window.api.invoke('notes:search', { query: title }) as { id: string; title: string }[]
    const note = rows.find((r) => r.title.toLowerCase() === title.toLowerCase())
    if (note) emit('open-note', { noteId: note.id, title: note.title, mode })
  } catch { /* not found — no-op */ }
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderInline(raw: string): string {
  // Pass 1: replace @EntityName and [[NoteTitle]] with placeholders before escaping
  // so the escape step doesn't break the button HTML we'll inject.
  const entityItems: { name: string }[] = []
  const noteLinkTitles: string[] = []

  const withEntityPlaceholders = raw.replace(
    /@([A-Za-z\u00C0-\u04FF][^\s@,.:!?"()\[\]{}<>#\n]{0,59})/g,
    (_m, name: string) => {
      const trimmed = name.replace(/[.,!?;:'")\]]+$/, '').trim()
      entityItems.push({ name: trimmed })
      return `WIZZENT${entityItems.length - 1}WIZZENT`
    },
  )
  const withNoteLinkPlaceholders = withEntityPlaceholders.replace(
    /\[\[([^\]]{1,200})\]\]/g,
    (_m, title: string) => {
      noteLinkTitles.push(title.trim())
      return `WIZZLINK${noteLinkTitles.length - 1}WIZZLINK`
    },
  )

  // Pass 2: standard inline markdown on the safe-escaped remainder
  const safe = escapeHtml(withNoteLinkPlaceholders)
  let result = safe
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')

  // Pass 3: substitute placeholders with styled buttons
  result = result.replace(/WIZZENT(\d+)WIZZENT/g, (_m, idxStr: string) => {
    const item = entityItems[Number(idxStr)]
    if (!item) return ''
    return `<button class="brief-entity-ref" data-entity-name="${escapeHtml(item.name)}">@${escapeHtml(item.name)}</button>`
  })
  result = result.replace(/WIZZLINK(\d+)WIZZLINK/g, (_m, idxStr: string) => {
    const title = noteLinkTitles[Number(idxStr)] ?? ''
    return `<button class="brief-note-ref" data-note-title="${escapeHtml(title)}">${escapeHtml(title)}</button>`
  })

  return result
}

function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let listType: 'ul-task' | 'ul' | null = null

  function closeList(): void {
    if (listType) { out.push('</ul>'); listType = null }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (hm) {
      closeList()
      const level = hm[1].length
      out.push(`<h${level}>${renderInline(hm[2])}</h${level}>`)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList()
      out.push('<hr>')
      continue
    }

    const tm = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (tm) {
      if (listType !== 'ul-task') { closeList(); out.push('<ul class="brief-task-list">'); listType = 'ul-task' }
      const checked = tm[1].toLowerCase() === 'x'
      out.push(
        `<li class="brief-task-item">` +
          `<span class="brief-checkbox${checked ? ' checked' : ''}">${checked ? '✓' : ''}</span>` +
          `<span class="brief-task-text">${renderInline(tm[2])}</span>` +
        `</li>`,
      )
      continue
    }

    const bm = trimmed.match(/^[-*]\s+(.+)$/)
    if (bm) {
      if (listType !== 'ul') { closeList(); out.push('<ul class="brief-bullet-list">'); listType = 'ul' }
      out.push(`<li>${renderInline(bm[1])}</li>`)
      continue
    }

    if (!trimmed) { closeList(); continue }

    closeList()
    out.push(`<p>${renderInline(trimmed)}</p>`)
  }

  closeList()
  return out.join('\n')
}
</script>

<template>
  <div class="today-view">

    <!-- Fixed header -->
    <div class="today-header">
      <!-- Left: date navigation -->
      <div class="today-nav">
        <button class="nav-arrow" title="Previous day" @click="goBack">
          <ChevronLeft :size="15" />
        </button>
        <span class="today-date">{{ dateTitle }}</span>
        <button
          class="nav-arrow"
          title="Next day"
          :disabled="isToday || isFuture"
          @click="goForward"
        >
          <ChevronRight :size="15" />
        </button>
        <button
          v-if="!isToday"
          class="btn-today"
          @click="goToToday"
        >
          Today
        </button>
      </div>

      <!-- Right: regenerate -->
      <div class="today-header-actions">
        <button
          v-if="brief && !loading"
          class="btn-regenerate"
          :disabled="generating"
          title="Regenerate brief"
          @click="generate"
        >
          <RefreshCw :size="13" :class="{ spin: generating }" />
          {{ generating ? 'Generating…' : 'Regenerate' }}
        </button>
      </div>
    </div>

    <!-- Scrollable body -->
    <div class="today-body">

      <!-- Initial loading skeleton -->
      <div v-if="loading" class="today-loading">
        <span class="today-spinner" />
        <p>Loading…</p>
      </div>

      <!-- Brief content -->
      <div v-else-if="brief" class="brief-card">
        <div v-if="generating" class="brief-regenerating">
          <span class="today-spinner" />
          <span>Regenerating…</span>
        </div>
        <div
          class="brief-body"
          :class="{ 'brief-body-dim': generating }"
          v-html="renderedBrief"
          @click="onBriefClick"
        />
      </div>

      <!-- Empty state -->
      <div v-else class="today-empty">
        <span class="today-empty-icon"><Sparkles :size="32" /></span>
        <h2>No brief for {{ isToday ? 'today' : 'this day' }}</h2>
        <p v-if="isToday">Generate a personalized briefing based on your calendar, action items, and recent notes.</p>
        <p v-else>No brief was generated for this day.</p>
        <button v-if="isToday" class="btn-generate" :disabled="generating" @click="generate">
          <Sparkles :size="14" />
          {{ generating ? 'Generating…' : 'Generate Daily Brief' }}
        </button>
      </div>

      <!-- Error -->
      <div v-if="error && !loading" class="today-error">{{ error }}</div>

    </div>
  </div>
</template>

<style scoped>
/* ── Layout ── */

.today-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--color-bg);
}

.today-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 32px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg);
  gap: 12px;
}

.today-body {
  flex: 1;
  overflow-y: auto;
  padding: 32px 48px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* ── Date navigation ── */

.today-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1;
}

.today-date {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  padding: 0 6px;
}

.nav-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  flex-shrink: 0;
}

.nav-arrow:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-text);
}

.nav-arrow:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.btn-today {
  margin-left: 6px;
  padding: 3px 10px;
  font-size: 11px;
  font-family: inherit;
  font-weight: 500;
  color: var(--color-accent);
  background: transparent;
  border: 1px solid var(--color-accent);
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
  opacity: 0.85;
  flex-shrink: 0;
}

.btn-today:hover {
  background: var(--color-accent);
  color: #fff;
  opacity: 1;
}

/* ── Regenerate ── */

.today-header-actions {
  flex-shrink: 0;
}

.btn-regenerate {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  font-size: 12px;
  font-family: inherit;
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
  white-space: nowrap;
}

.btn-regenerate:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-text-muted);
  background: var(--color-hover);
}

.btn-regenerate:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Loading ── */

.today-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 80px 24px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.today-loading p {
  margin: 0;
}

.today-spinner {
  display: block;
  width: 20px;
  height: 20px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.spin {
  animation: spin 0.7s linear infinite;
}

/* ── Brief card ── */

.brief-card {
  width: 100%;
  max-width: 720px;
  position: relative;
}

.brief-regenerating {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  font-size: 13px;
  color: var(--color-text-muted);
  z-index: 1;
  background: var(--color-bg);
  opacity: 0.85;
  border-radius: 8px;
}

.brief-body {
  transition: opacity 0.2s;
}

.brief-body-dim {
  opacity: 0.25;
  pointer-events: none;
}

/* ── Brief markdown styles ── */

:deep(.brief-body h1) {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-text);
  margin: 0 0 20px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--color-border);
}

:deep(.brief-body h2) {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  margin: 28px 0 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

:deep(.brief-body h3) {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  margin: 20px 0 8px;
}

:deep(.brief-body p) {
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.65;
  margin: 6px 0;
}

:deep(.brief-body hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 24px 0;
}

:deep(.brief-body strong) { font-weight: 600; }
:deep(.brief-body em) { font-style: italic; }

:deep(.brief-body code) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  background: var(--color-hover);
  border: 1px solid var(--color-border);
  border-radius: 3px;
  padding: 1px 4px;
  color: var(--color-text);
}

:deep(.brief-bullet-list) {
  margin: 6px 0 12px;
  padding-left: 18px;
  list-style: disc;
}

:deep(.brief-bullet-list li) {
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.65;
  margin-bottom: 4px;
}

:deep(.brief-task-list) {
  margin: 6px 0 12px;
  padding: 0;
  list-style: none;
}

:deep(.brief-task-item) {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.65;
  margin-bottom: 5px;
}

:deep(.brief-checkbox) {
  flex-shrink: 0;
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--color-border);
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: transparent;
  background: transparent;
  position: relative;
  top: 1px;
}

:deep(.brief-checkbox.checked) {
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: white;
}

:deep(.brief-task-text) { flex: 1; }

/* Entity mention chip — matches MentionChip / .chat-entity-ref styling */
:deep(.brief-entity-ref) {
  display: inline-flex;
  align-items: center;
  background: rgba(91, 141, 239, 0.15);
  color: var(--color-accent);
  border: 1px solid rgba(91, 141, 239, 0.3);
  border-radius: 6px;
  padding: 1px 6px;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  margin: 0 1px;
  vertical-align: middle;
  font-family: inherit;
  line-height: 1.4;
}
:deep(.brief-entity-ref:hover) { background: rgba(91, 141, 239, 0.25); }

/* Note link chip in brief — matches .chat-note-ref tone */
:deep(.brief-note-ref) {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11.5px;
  font-weight: 500;
  background: rgba(91, 141, 239, 0.15);
  color: var(--color-accent);
  border: 1px solid rgba(91, 141, 239, 0.3);
  cursor: pointer;
  vertical-align: middle;
  white-space: nowrap;
  font-family: inherit;
  line-height: 1.4;
}
:deep(.brief-note-ref:hover) { background: rgba(91, 141, 239, 0.25); }

/* ── Empty state ── */

.today-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 80px 32px;
  gap: 12px;
  max-width: 400px;
}

.today-empty-icon {
  color: var(--color-text-muted);
  opacity: 0.4;
  margin-bottom: 4px;
}

.today-empty h2 {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.today-empty p {
  font-size: 13px;
  color: var(--color-text-muted);
  line-height: 1.55;
  margin: 0;
}

.btn-generate {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  padding: 9px 18px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  color: #fff;
  background: var(--color-accent);
  border: none;
  border-radius: 7px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.btn-generate:hover:not(:disabled) { opacity: 0.88; }
.btn-generate:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Error ── */

.today-error {
  margin-top: 16px;
  padding: 10px 16px;
  background: rgba(220, 38, 38, 0.08);
  border: 1px solid rgba(220, 38, 38, 0.25);
  border-radius: 6px;
  font-size: 12px;
  color: #dc2626;
  max-width: 620px;
  width: 100%;
}
</style>
