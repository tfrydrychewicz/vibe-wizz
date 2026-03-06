<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { CheckSquare, Clock, AlertCircle, Moon, CalendarCheck } from 'lucide-vue-next'
import TaskCard from './TaskCard.vue'
import type { ActionItem } from './TaskCard.vue'
import type { OpenMode } from '../stores/tabStore'

const emit = defineEmits<{
  'open-note': [payload: { noteId: string; title: string; mode: OpenMode }]
}>()

const loading = ref(false)
const lastReviewAt = ref<string | null>(null)
const staleDays = ref(7)

const overdueTasks = ref<ActionItem[]>([])
const staleTasks = ref<ActionItem[]>([])
const waitingTasks = ref<ActionItem[]>([])
const somedayTasks = ref<ActionItem[]>([])

const today = new Date().toISOString().slice(0, 10)

async function load(): Promise<void> {
  loading.value = true
  try {
    const [active, waiting, someday, lastReview, staleDaysSetting] = await Promise.all([
      window.api.invoke('action-items:list', { status_multi: ['open', 'in_progress'] }) as Promise<ActionItem[]>,
      window.api.invoke('action-items:list', { is_waiting_for: 1 }) as Promise<ActionItem[]>,
      window.api.invoke('action-items:list', { status_multi: ['someday'] }) as Promise<ActionItem[]>,
      window.api.invoke('settings:get', { key: 'gtd_last_review_at' }) as Promise<string | null>,
      window.api.invoke('settings:get', { key: 'followup_staleness_days' }) as Promise<string | null>,
    ])

    lastReviewAt.value = lastReview
    staleDays.value = staleDaysSetting ? parseInt(staleDaysSetting, 10) : 7

    // Overdue: has due_date before today
    overdueTasks.value = (active as ActionItem[]).filter((t) => t.due_date && t.due_date < today)

    // Stale: open (not done), not updated in N days
    const staleThreshold = new Date()
    staleThreshold.setDate(staleThreshold.getDate() - staleDays.value)
    staleTasks.value = (active as ActionItem[]).filter((t) => {
      if (t.status !== 'open') return false
      const updated = t.updated_at ? new Date(t.updated_at) : new Date(t.created_at)
      return updated < staleThreshold
    })

    waitingTasks.value = waiting as ActionItem[]
    somedayTasks.value = someday as ActionItem[]
  } finally {
    loading.value = false
  }
}

async function markReviewed(): Promise<void> {
  await window.api.invoke('settings:set', { key: 'gtd_last_review_at', value: new Date().toISOString() })
  lastReviewAt.value = new Date().toISOString()
}

async function activateSomeday(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:update', { id: task.id, status: 'open' })
  somedayTasks.value = somedayTasks.value.filter((t) => t.id !== task.id)
}

async function deleteSomeday(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:delete', { id: task.id })
  somedayTasks.value = somedayTasks.value.filter((t) => t.id !== task.id)
}

function ageLabel(task: ActionItem): string {
  const d = task.updated_at ? new Date(task.updated_at) : new Date(task.created_at)
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

const formattedLastReview = computed(() => {
  if (!lastReviewAt.value) return 'Never'
  return new Date(lastReviewAt.value).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
})

onMounted(load)
</script>

<template>
  <div class="weekly-review">
    <div class="review-header">
      <div class="review-meta">
        <CalendarCheck :size="14" class="review-icon" />
        <span>Last reviewed: <strong>{{ formattedLastReview }}</strong></span>
      </div>
      <button class="btn-mark-reviewed" @click="markReviewed">
        <CheckSquare :size="13" /> Mark week reviewed
      </button>
    </div>

    <div v-if="loading" class="review-loading">Loading…</div>

    <template v-else>
      <!-- ── Overdue ─────────────────────────────────────────────────────── -->
      <div class="review-section">
        <div class="section-header section-header--danger">
          <AlertCircle :size="13" />
          Overdue
          <span class="section-count">{{ overdueTasks.length }}</span>
        </div>
        <div v-if="overdueTasks.length > 0" class="section-tasks">
          <TaskCard
            v-for="t in overdueTasks"
            :key="t.id"
            :task="t"
            :show-project="true"
            :show-source-note="true"
            @open-note="emit('open-note', $event)"
            @status-changed="(id, status) => { const i = overdueTasks.findIndex(x => x.id === id); if (i !== -1) overdueTasks[i] = { ...overdueTasks[i], status } }"
            @subtask-created="() => {}"
          />
        </div>
        <p v-else class="section-empty">Nothing overdue 🎉</p>
      </div>

      <!-- ── Stale ───────────────────────────────────────────────────────── -->
      <div class="review-section">
        <div class="section-header section-header--warn">
          <Clock :size="13" />
          Stale (no update in {{ staleDays }}+ days)
          <span class="section-count">{{ staleTasks.length }}</span>
        </div>
        <div v-if="staleTasks.length > 0" class="section-tasks">
          <div v-for="t in staleTasks" :key="t.id" class="stale-row">
            <TaskCard
              :task="t"
              :show-project="true"
              :show-source-note="false"
              @open-note="emit('open-note', $event)"
              @status-changed="(id, status) => { const i = staleTasks.findIndex(x => x.id === id); if (i !== -1) staleTasks[i] = { ...staleTasks[i], status } }"
              @subtask-created="() => {}"
            />
            <span class="age-badge">{{ ageLabel(t) }}</span>
          </div>
        </div>
        <p v-else class="section-empty">No stale tasks</p>
      </div>

      <!-- ── Waiting For ─────────────────────────────────────────────────── -->
      <div class="review-section">
        <div class="section-header section-header--waiting">
          <Clock :size="13" />
          Waiting For
          <span class="section-count">{{ waitingTasks.length }}</span>
        </div>
        <div v-if="waitingTasks.length > 0" class="section-tasks">
          <div v-for="t in waitingTasks" :key="t.id" class="stale-row">
            <TaskCard
              :task="t"
              :show-project="true"
              :show-source-note="false"
              @open-note="emit('open-note', $event)"
              @status-changed="(id, status) => { const i = waitingTasks.findIndex(x => x.id === id); if (i !== -1) waitingTasks[i] = { ...waitingTasks[i], status } }"
              @subtask-created="() => {}"
            />
            <span class="age-badge">{{ ageLabel(t) }}</span>
          </div>
        </div>
        <p v-else class="section-empty">Nothing waiting</p>
      </div>

      <!-- ── Someday / Maybe ────────────────────────────────────────────── -->
      <div class="review-section">
        <div class="section-header section-header--someday">
          <Moon :size="13" />
          Someday / Maybe
          <span class="section-count">{{ somedayTasks.length }}</span>
        </div>
        <div v-if="somedayTasks.length > 0" class="section-tasks">
          <div v-for="t in somedayTasks" :key="t.id" class="someday-row">
            <span class="someday-title">{{ t.title }}</span>
            <div class="someday-actions">
              <button class="btn-activate" @click="activateSomeday(t)">Activate</button>
              <button class="btn-delete-someday" @click="deleteSomeday(t)">Delete</button>
            </div>
          </div>
        </div>
        <p v-else class="section-empty">No someday tasks</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.weekly-review {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 4px 0;
}

.review-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.review-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.review-icon {
  color: var(--color-accent);
}

.btn-mark-reviewed {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
}

.btn-mark-reviewed:hover {
  opacity: 0.9;
}

.review-loading {
  font-size: 13px;
  color: var(--color-text-muted);
  text-align: center;
  padding: 24px;
}

.review-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
}

.section-header--danger { color: #ef4444; }
.section-header--warn   { color: #f59e0b; }
.section-header--waiting { color: #8b5cf6; }
.section-header--someday { color: #6b7280; }

.section-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 400;
  opacity: 0.7;
}

.section-tasks {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.section-empty {
  font-size: 13px;
  color: var(--color-text-muted);
  opacity: 0.5;
  margin: 0;
  padding: 4px 0;
}

.stale-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stale-row > :first-child {
  flex: 1;
  min-width: 0;
}

.age-badge {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  opacity: 0.7;
}

.someday-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  gap: 12px;
}

.someday-title {
  font-size: 13px;
  color: var(--color-text);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}

.someday-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.btn-activate {
  padding: 3px 8px;
  background: rgba(34,197,94,0.12);
  color: #22c55e;
  border: 1px solid rgba(34,197,94,0.3);
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.btn-activate:hover {
  background: rgba(34,197,94,0.2);
}

.btn-delete-someday {
  padding: 3px 8px;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.btn-delete-someday:hover {
  background: rgba(239,68,68,0.08);
  color: #ef4444;
  border-color: rgba(239,68,68,0.3);
}
</style>
