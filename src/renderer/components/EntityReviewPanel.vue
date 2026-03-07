<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { ChevronDown, ChevronRight, RefreshCw, Trash2, ClipboardList } from 'lucide-vue-next'
import { markdownToHtml } from '../utils/markdown'
import type { OpenMode } from '../stores/tabStore'
import { useEntityChips } from '../composables/useEntityChips'
import { fireShowInlineDetail } from '../stores/taskInlineDetailStore'

// ── Types ─────────────────────────────────────────────────────────────────────

interface EntityReview {
  id: string
  entity_id: string
  period_start: string
  period_end: string
  content: string
  generated_at: string
  model_id: string | null
  acknowledged_at: string | null
}

// ── Chip styling ──────────────────────────────────────────────────────────────

const panelBodyRef = ref<HTMLElement | null>(null)
const { applyAfterTick } = useEntityChips()

// ── Props / emits ─────────────────────────────────────────────────────────────

const props = defineProps<{
  entityId: string
  reviewEnabled: boolean
}>()

const emit = defineEmits<{
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
  'open-entity': [{ entityId: string; typeId: string; mode: OpenMode }]
  'navigate-to-event': [{ eventId: number; clientX: number; clientY: number }]
}>()

// ── State ─────────────────────────────────────────────────────────────────────

const reviews = ref<EntityReview[]>([])
const loading = ref(false)
const generating = ref(false)
const generateError = ref<string | null>(null)
const expandedIds = ref(new Set<string>())
const confirmDeleteId = ref<string | null>(null)

// Collapse state persisted to localStorage per entity
function storageKey(): string {
  return `entity-reviews-panel-${props.entityId}`
}

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(storageKey()) === 'collapsed'
  } catch {
    return false
  }
}

function saveCollapsed(v: boolean): void {
  try {
    localStorage.setItem(storageKey(), v ? 'collapsed' : 'expanded')
  } catch { /* non-critical */ }
}

const isCollapsed = ref(loadCollapsed())

// ── Computed ──────────────────────────────────────────────────────────────────

const unacknowledgedCount = computed(
  () => reviews.value.filter((r) => !r.acknowledged_at).length,
)

const panelOpen = computed(() => !isCollapsed.value)

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDateRange(start: string, end: string): string {
  const fmt = (d: string): string =>
    new Date(`${d}T12:00:00`).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`
}

function formatGenerated(iso: string): string {
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
}

function preview(content: string): string {
  const plain = content.replace(/#{1,6}\s+/g, '').replace(/[*_`]/g, '').trim()
  return plain.length > 220 ? plain.slice(0, 220) + '…' : plain
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadReviews(): Promise<void> {
  loading.value = true
  try {
    const rows = (await window.api.invoke('entity-reviews:list', {
      entity_id: props.entityId,
    })) as EntityReview[]
    reviews.value = rows

    // Auto-expand panel when there are unacknowledged reviews
    if (rows.some((r) => !r.acknowledged_at) && isCollapsed.value) {
      isCollapsed.value = false
      saveCollapsed(false)
    }
  } catch (err) {
    console.error('[EntityReviewPanel] loadReviews error:', err)
  } finally {
    loading.value = false
  }
}

// ── Push events ───────────────────────────────────────────────────────────────

const unsub = window.api.on(
  'entity-review:complete',
  (payload: unknown) => {
    const p = payload as { entityId: string; reviewId: string }
    if (p.entityId === props.entityId) void loadReviews()
  },
)
onBeforeUnmount(() => unsub())

// ── Panel toggle ──────────────────────────────────────────────────────────────

function togglePanel(): void {
  isCollapsed.value = !isCollapsed.value
  saveCollapsed(isCollapsed.value)
}

// ── Expand / collapse individual reviews ─────────────────────────────────────

async function toggleReview(review: EntityReview): Promise<void> {
  if (expandedIds.value.has(review.id)) {
    expandedIds.value.delete(review.id)
  } else {
    expandedIds.value.add(review.id)
    if (!review.acknowledged_at) {
      review.acknowledged_at = new Date().toISOString()
      window.api.invoke('entity-reviews:acknowledge', { id: review.id }).catch(() => { /* non-critical */ })
    }
    void applyAfterTick(panelBodyRef.value)
  }
}

// ── Generate now ──────────────────────────────────────────────────────────────

async function generateNow(): Promise<void> {
  generating.value = true
  generateError.value = null
  try {
    const result = (await window.api.invoke('entity-reviews:generate', {
      entity_id: props.entityId,
    })) as EntityReview | { error: string }
    if ('error' in result) {
      generateError.value = result.error
    } else {
      reviews.value = [result, ...reviews.value]
      // Auto-expand newly generated review
      expandedIds.value.add(result.id)
      result.acknowledged_at = new Date().toISOString()
      window.api.invoke('entity-reviews:acknowledge', { id: result.id }).catch(() => { /* non-critical */ })
      // Ensure panel is open
      if (isCollapsed.value) {
        isCollapsed.value = false
        saveCollapsed(false)
      }
      void applyAfterTick(panelBodyRef.value)
    }
  } catch (err) {
    generateError.value = 'Failed to generate review. Check your AI configuration.'
    console.error('[EntityReviewPanel] generate error:', err)
  } finally {
    generating.value = false
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteReview(id: string): Promise<void> {
  await window.api.invoke('entity-reviews:delete', { id })
  reviews.value = reviews.value.filter((r) => r.id !== id)
  expandedIds.value.delete(id)
  confirmDeleteId.value = null
}

// ── Click delegation for note/entity chips in rendered review body ────────────

async function onBodyClick(e: MouseEvent): Promise<void> {
  const target = e.target as HTMLElement
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'

  const webChip = target.closest('[data-web-url]') as HTMLElement | null
  if (webChip) {
    e.preventDefault()
    const url = webChip.dataset.webUrl
    if (url) void window.api.invoke('shell:open-external', { url })
    return
  }

  const actionChip = target.closest('[data-action-id]') as HTMLElement | null
  if (actionChip) {
    const id = actionChip.dataset.actionId
    if (id) fireShowInlineDetail(id, new DOMRect(e.clientX, e.clientY, 0, 0))
    return
  }

  const eventChip = target.closest('[data-event-id]') as HTMLElement | null
  if (eventChip) {
    const id = eventChip.dataset.eventId
    if (id) emit('navigate-to-event', { eventId: Number(id), clientX: e.clientX, clientY: e.clientY })
    return
  }

  const noteBtn = target.closest('[data-note-title]') as HTMLElement | null
  if (noteBtn) {
    const noteId = noteBtn.dataset.noteId
    const title = noteBtn.dataset.noteTitle ?? ''
    if (noteId) {
      emit('open-note', { noteId, title, mode })
    } else if (title) {
      const results = await window.api.invoke('notes:search', { query: title }) as { id: string; title: string }[]
      const match = results.find((r) => r.title.toLowerCase() === title.toLowerCase()) ?? results[0]
      if (match) emit('open-note', { noteId: match.id, title: match.title, mode })
    }
    return
  }

  const entityBtn = target.closest('[data-entity-name]') as HTMLElement | null
  if (entityBtn) {
    const entityId = entityBtn.dataset.entityId
    const entityName = entityBtn.dataset.entityName ?? ''
    if (entityId) {
      const result = await window.api.invoke('entities:get', { id: entityId }) as { entity: { type_id: string } } | null
      if (result) emit('open-entity', { entityId, typeId: result.entity.type_id, mode })
    } else if (entityName) {
      const results = await window.api.invoke('entities:search', { query: entityName }) as { id: string; name: string; type_id: string }[]
      const match = results.find((r) => r.name.toLowerCase() === entityName.toLowerCase()) ?? results[0]
      if (match) emit('open-entity', { entityId: match.id, typeId: match.type_id, mode })
    }
    return
  }
}

// ── Watch entityId changes ────────────────────────────────────────────────────

watch(
  () => props.entityId,
  () => {
    reviews.value = []
    expandedIds.value.clear()
    confirmDeleteId.value = null
    generateError.value = null
    isCollapsed.value = loadCollapsed()
    void loadReviews()
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="reviewEnabled" class="review-panel">

    <!-- Panel header -->
    <button class="review-panel-header" @click="togglePanel">
      <span class="review-panel-title">
        <ClipboardList :size="13" class="review-panel-icon" />
        Reviews
        <span v-if="unacknowledgedCount > 0" class="unread-dot" :title="`${unacknowledgedCount} new`" />
      </span>
      <span class="review-panel-meta">
        <span v-if="reviews.length" class="review-count">{{ reviews.length }}</span>
        <button
          class="btn-generate-now"
          :disabled="generating"
          title="Generate review now"
          @click.stop="generateNow"
        >
          <RefreshCw :size="12" :class="{ spin: generating }" />
          {{ generating ? 'Generating…' : 'Generate now' }}
        </button>
        <component :is="panelOpen ? ChevronDown : ChevronRight" :size="14" class="chevron" />
      </span>
    </button>

    <!-- Error from generate -->
    <p v-if="generateError" class="generate-error">{{ generateError }}</p>

    <!-- Panel body -->
    <div v-if="panelOpen" ref="panelBodyRef" class="review-panel-body">

      <!-- Loading skeleton -->
      <div v-if="loading" class="review-loading">
        <span class="spinner" />
      </div>

      <!-- Empty state -->
      <div v-else-if="reviews.length === 0" class="review-empty">
        No reviews generated yet. Click "Generate now" to create the first one.
      </div>

      <!-- Review rows -->
      <template v-else>
        <div
          v-for="review in reviews"
          :key="review.id"
          class="review-row"
          :class="{ 'review-row-unread': !review.acknowledged_at }"
        >
          <!-- Row header -->
          <div class="review-row-header">
            <button class="review-row-toggle" @click="toggleReview(review)">
              <component :is="expandedIds.has(review.id) ? ChevronDown : ChevronRight" :size="12" />
              <span class="review-date-range">{{ formatDateRange(review.period_start, review.period_end) }}</span>
              <span v-if="!review.acknowledged_at" class="unread-dot unread-dot-sm" />
            </button>
            <span class="review-generated-at">Generated {{ formatGenerated(review.generated_at) }}</span>

            <!-- Delete -->
            <template v-if="confirmDeleteId === review.id">
              <button class="btn-delete-confirm" @click="deleteReview(review.id)">Delete</button>
              <button class="btn-delete-cancel" @click="confirmDeleteId = null">Cancel</button>
            </template>
            <button
              v-else
              class="btn-review-delete"
              title="Delete this review"
              @click="confirmDeleteId = review.id"
            >
              <Trash2 :size="11" />
            </button>
          </div>

          <!-- Collapsed preview -->
          <p v-if="!expandedIds.has(review.id)" class="review-preview" @click="toggleReview(review)">
            {{ preview(review.content) }}
          </p>

          <!-- Expanded full body -->
          <div
            v-else
            class="review-body"
            v-html="markdownToHtml(review.content)"
            @click="onBodyClick"
          />
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.review-panel {
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* ── Header ── */

.review-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 10px 24px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s;
}

.review-panel-header:hover {
  background: var(--color-hover);
}

.review-panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.review-panel-icon {
  color: var(--color-text-muted);
}

.review-panel-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.review-count {
  font-size: 11px;
  color: var(--color-text-muted);
}

.chevron {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

/* ── Unread dot ── */

.unread-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-accent);
  flex-shrink: 0;
}

.unread-dot-sm {
  width: 5px;
  height: 5px;
}

/* ── Generate button ── */

.btn-generate-now {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 11px;
  font-family: inherit;
  color: var(--color-text-muted);
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}

.btn-generate-now:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-text-muted);
  background: var(--color-hover);
}

.btn-generate-now:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spin {
  animation: spin 0.7s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Error ── */

.generate-error {
  margin: 0 24px 8px;
  padding: 7px 10px;
  background: rgba(220, 38, 38, 0.07);
  border: 1px solid rgba(220, 38, 38, 0.2);
  border-radius: 5px;
  font-size: 12px;
  color: #dc2626;
}

/* ── Body ── */

.review-panel-body {
  padding: 0 0 12px;
  max-height: 480px;
  overflow-y: auto;
}

.review-loading {
  display: flex;
  justify-content: center;
  padding: 16px;
}

.spinner {
  display: block;
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.review-empty {
  padding: 12px 24px;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

/* ── Review rows ── */

.review-row {
  border-top: 1px solid var(--color-border);
}

.review-row-unread .review-date-range {
  font-weight: 600;
  color: var(--color-text);
}

.review-row-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 24px 4px;
}

.review-row-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  padding: 0;
  font-family: inherit;
  flex: 1;
  min-width: 0;
}

.review-date-range {
  font-size: 12px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.review-generated-at {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

/* Delete controls */

.btn-review-delete {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 3px 4px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text-muted);
  border-radius: 3px;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s;
  flex-shrink: 0;
}

.review-row:hover .btn-review-delete {
  opacity: 1;
}

.btn-review-delete:hover {
  color: #f06070;
}

.btn-delete-confirm {
  font-size: 11px;
  font-family: inherit;
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid rgba(240, 96, 112, 0.5);
  background: rgba(240, 96, 112, 0.1);
  color: #f06070;
  cursor: pointer;
  white-space: nowrap;
}

.btn-delete-confirm:hover {
  background: rgba(240, 96, 112, 0.2);
}

.btn-delete-cancel {
  font-size: 11px;
  font-family: inherit;
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  white-space: nowrap;
}

/* ── Preview / body ── */

.review-preview {
  margin: 0;
  padding: 2px 24px 10px 36px;
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.55;
  cursor: pointer;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.review-preview:hover {
  color: var(--color-text);
}

.review-body {
  padding: 4px 24px 12px 24px;
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.6;
}

/* Markdown styles inside expanded review body */
:deep(.review-body h1) { font-size: 16px; font-weight: 700; margin: 12px 0 6px; color: var(--color-text); }
:deep(.review-body h2) { font-size: 11px; font-weight: 600; margin: 14px 0 5px; color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
:deep(.review-body h3) { font-size: 13px; font-weight: 600; margin: 10px 0 4px; color: var(--color-text); }
:deep(.review-body p)  { margin: 4px 0; font-size: 13px; line-height: 1.6; }
:deep(.review-body hr) { border: none; border-top: 1px solid var(--color-border); margin: 10px 0; }
:deep(.review-body strong) { font-weight: 600; }
:deep(.review-body em) { font-style: italic; }
:deep(.review-body code) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11px;
  background: var(--color-hover);
  border: 1px solid var(--color-border);
  border-radius: 3px;
  padding: 1px 4px;
}
:deep(.review-body .brief-bullet-list) { margin: 4px 0 8px; padding-left: 18px; list-style: disc; }
:deep(.review-body .brief-bullet-list li) { font-size: 13px; line-height: 1.6; margin-bottom: 3px; }
:deep(.review-body .brief-task-list) { margin: 4px 0 8px; padding: 0; list-style: none; }
:deep(.review-body .brief-task-item) { display: flex; align-items: baseline; gap: 7px; font-size: 13px; line-height: 1.6; margin-bottom: 3px; }
:deep(.review-body .brief-checkbox) { flex-shrink: 0; width: 13px; height: 13px; border: 1.5px solid var(--color-border); border-radius: 3px; display: flex; align-items: center; justify-content: center; font-size: 8px; color: transparent; position: relative; top: 1px; }
:deep(.review-body .brief-checkbox.checked) { background: var(--color-accent); border-color: var(--color-accent); color: white; }
:deep(.review-body .brief-task-text) { flex: 1; }
/* Chip styling lives in the global style.css (.wizz-entity-chip, .wizz-note-chip) */
</style>
