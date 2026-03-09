<script setup lang="ts">
import { ref, computed, nextTick } from 'vue'
import { FileText, Plus, Clock } from 'lucide-vue-next'
import TaskAttributeChip from './TaskAttributeChip.vue'
import SubTaskInput from './SubTaskInput.vue'
import type { OpenMode } from '../stores/tabStore'
import { fireOpenDetail } from '../stores/taskDetailStore'

// ── Shared ActionItem type (re-exported for use in other components) ──────────
export interface ActionItem {
  id: string
  title: string
  status: 'open' | 'in_progress' | 'done' | 'cancelled' | 'someday'
  extraction_type: 'manual' | 'ai_extracted'
  confidence: number
  created_at: string
  updated_at: string | null
  completed_at: string | null
  source_note_id: string | null
  assigned_entity_id: string | null
  parent_id: string | null
  project_entity_id: string | null
  /** JSON string array, e.g. '["@computer","@phone"]' */
  contexts: string
  energy_level: 'low' | 'medium' | 'high' | null
  /** SQLite BOOLEAN: 0 or 1 */
  is_waiting_for: number
  /** SQLite BOOLEAN: 0 or 1 — task has been processed into the To Do list */
  is_next_action: number
  waiting_for_entity_id: string | null
  due_date: string | null
  source_note_title: string | null
  assigned_entity_name: string | null
  project_name: string | null
  waiting_for_entity_name: string | null
  subtask_count: number
  open_subtask_count: number
}

const props = withDefaults(
  defineProps<{
    task: ActionItem
    /** 0 = top-level, 1 = sub-task (indented, smaller) */
    depth?: number
    showProject?: boolean
    showSourceNote?: boolean
  }>(),
  { depth: 0, showProject: true, showSourceNote: false },
)

const emit = defineEmits<{
  'open-detail': [taskId: string]
  'status-changed': [taskId: string, status: ActionItem['status']]
  'open-note': [payload: { noteId: string; title: string; mode: OpenMode }]
  'subtask-created': [task: ActionItem]
}>()

// ── Parsed / derived values ───────────────────────────────────────────────────
const parsedContexts = computed<string[]>(() => {
  try { return JSON.parse(props.task.contexts) as string[] }
  catch { return [] }
})

const isWaiting = computed(() => props.task.is_waiting_for === 1)

const isOverdue = computed(() => {
  if (!props.task.due_date || props.task.status === 'done' || props.task.status === 'cancelled') return false
  return new Date(props.task.due_date) < new Date(new Date().toDateString())
})

const isDueToday = computed(() => {
  if (!props.task.due_date) return false
  return props.task.due_date === new Date().toISOString().slice(0, 10)
})

const formattedDueDate = computed(() => {
  if (!props.task.due_date) return null
  const d = new Date(props.task.due_date)
  const today = new Date()
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const ds = d.toDateString()
  if (ds === today.toDateString()) return 'Today'
  if (ds === tomorrow.toDateString()) return 'Tomorrow'
  if (ds === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
})

const statusDotClass = computed(() => {
  const map: Record<string, string> = {
    open:        'dot-open',
    in_progress: 'dot-progress',
    done:        'dot-done',
    cancelled:   'dot-cancelled',
    someday:     'dot-someday',
  }
  return map[props.task.status] ?? 'dot-open'
})

const isDone = computed(() => props.task.status === 'done')

// Visible contexts — show up to 3
const visibleContexts = computed(() => parsedContexts.value.slice(0, 3))
const extraContextCount = computed(() => Math.max(0, parsedContexts.value.length - 3))

// ── Checkbox toggle ───────────────────────────────────────────────────────────
const togglingStatus = ref(false)

async function toggleChecked(): Promise<void> {
  if (togglingStatus.value) return
  const newStatus: ActionItem['status'] = isDone.value ? 'open' : 'done'
  togglingStatus.value = true
  try {
    await window.api.invoke('action-items:update', { id: props.task.id, status: newStatus })
    emit('status-changed', props.task.id, newStatus)
  } finally {
    togglingStatus.value = false
  }
}

// ── Source note open ──────────────────────────────────────────────────────────
function openNote(e: MouseEvent): void {
  if (!props.task.source_note_id) return
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: props.task.source_note_id, title: props.task.source_note_title ?? 'Untitled', mode })
}

// ── Add sub-task ──────────────────────────────────────────────────────────────
const showSubTaskInput = ref(false)
const subTaskInputRef = ref<InstanceType<typeof SubTaskInput> | null>(null)

function openSubTaskInput(): void {
  showSubTaskInput.value = true
  nextTick(() => subTaskInputRef.value?.focus())
}

function onSubTaskCreated(task: ActionItem): void {
  emit('subtask-created', task)
  showSubTaskInput.value = false
}
</script>

<template>
  <div
    class="task-card"
    :class="{
      'task-card--done': isDone,
      'task-card--sub': depth > 0,
      'task-card--someday': task.status === 'someday',
    }"
  >
    <div class="card-main">
      <!-- Checkbox -->
      <button
        class="checkbox"
        :class="{ 'checkbox--checked': isDone }"
        :disabled="togglingStatus || task.status === 'cancelled'"
        :title="isDone ? 'Mark open' : 'Mark done'"
        @click.stop="toggleChecked"
      >
        <svg v-if="isDone" width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path d="M1.5 5l2.5 2.5 4.5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <!-- Title + meta row -->
      <div class="card-body">
        <div class="card-title-row">
          <span class="card-dot" :class="statusDotClass" />
          <button class="card-title" @click.stop="fireOpenDetail(task.id)">
            {{ task.title }}
          </button>
        </div>

        <!-- Chips row -->
        <div v-if="showProject && task.project_name || visibleContexts.length || task.energy_level || isWaiting || task.assigned_entity_name || formattedDueDate || (showSourceNote && task.source_note_id)" class="chips-row">
          <!-- Project -->
          <TaskAttributeChip
            v-if="showProject && task.project_name"
            type="project"
            :label="task.project_name"
          />

          <!-- Due date -->
          <span
            v-if="formattedDueDate"
            class="due-badge"
            :class="{ 'due-badge--overdue': isOverdue, 'due-badge--today': isDueToday && !isOverdue }"
          >
            {{ formattedDueDate }}
          </span>

          <!-- Contexts -->
          <TaskAttributeChip
            v-for="ctx in visibleContexts"
            :key="ctx"
            type="context"
            :label="ctx"
          />
          <span v-if="extraContextCount > 0" class="extra-contexts">+{{ extraContextCount }}</span>

          <!-- Energy -->
          <TaskAttributeChip
            v-if="task.energy_level"
            type="energy"
            :label="task.energy_level"
            :energy-level="task.energy_level"
          />

          <!-- Assignee -->
          <span v-if="task.assigned_entity_name" class="assignee-chip">
            @{{ task.assigned_entity_name }}
          </span>

          <!-- Waiting for -->
          <TaskAttributeChip
            v-if="isWaiting"
            type="waiting"
            :label="task.waiting_for_entity_name ? `Waiting: ${task.waiting_for_entity_name}` : 'Waiting'"
          />

          <!-- Source note -->
          <button
            v-if="showSourceNote && task.source_note_id"
            class="source-note-chip"
            :title="task.source_note_title ?? 'Note'"
            @click.stop="openNote($event)"
          >
            <FileText :size="9" />
            {{ task.source_note_title ?? 'Note' }}
          </button>
        </div>
      </div>

      <!-- Right meta: sub-task count + add-subtask hover button -->
      <div class="card-right">
        <span
          v-if="task.subtask_count > 0"
          class="subtask-count"
          :class="{ 'subtask-count--all-done': task.open_subtask_count === 0 }"
          :title="`${task.open_subtask_count} open of ${task.subtask_count} sub-tasks`"
        >
          {{ task.open_subtask_count }}/{{ task.subtask_count }}
        </span>
        <button
          v-if="depth === 0"
          class="btn-add-subtask"
          title="Add sub-task"
          @click.stop="openSubTaskInput"
        >
          <Plus :size="11" />
        </button>
        <Clock
          v-if="isWaiting && !task.waiting_for_entity_name"
          :size="12"
          class="waiting-icon"
          title="Waiting for someone"
        />
      </div>
    </div>

    <!-- Sub-task input (shown on + click) -->
    <SubTaskInput
      v-if="showSubTaskInput"
      ref="subTaskInputRef"
      :parent-id="task.id"
      :source-note-id="task.source_note_id"
      @created="onSubTaskCreated"
      @cancel="showSubTaskInput = false"
    />
  </div>
</template>

<style scoped>
.task-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
}

.task-card--sub {
  background: var(--color-surface);
  border-radius: 5px;
  padding: 6px 8px;
  margin-left: 20px;
  border-color: transparent;
  border-left: 2px solid var(--color-border);
}

.task-card--done .card-title {
  text-decoration: line-through;
  opacity: 0.45;
}

.task-card--someday {
  opacity: 0.7;
}

/* ── Main row ─────────────────────────────────────────────────────────────── */
.card-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}

/* ── Checkbox ─────────────────────────────────────────────────────────────── */
.checkbox {
  width: 16px;
  height: 16px;
  min-width: 16px;
  border: 1.5px solid var(--color-border);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin-top: 1px;
  flex-shrink: 0;
  transition: border-color 0.1s, background 0.1s;
  color: #fff;
}

.checkbox:hover:not(:disabled) {
  border-color: #22c55e;
  background: rgba(34,197,94,0.08);
}

.checkbox--checked {
  background: #22c55e;
  border-color: #22c55e;
}

.checkbox:disabled {
  cursor: default;
  opacity: 0.4;
}

/* ── Body ─────────────────────────────────────────────────────────────────── */
.card-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.card-title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.card-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-open      { background: #6b7280; }
.dot-progress  { background: #f59e0b; }
.dot-done      { background: #22c55e; }
.dot-cancelled { background: #9ca3af; }
.dot-someday   { background: #8b5cf6; }

.card-title {
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  font-weight: 450;
  cursor: pointer;
  padding: 0;
  text-align: left;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 100%;
}

.task-card--sub .card-title {
  font-size: 12px;
}

.card-title:hover {
  color: var(--color-accent);
}

/* ── Chips row ────────────────────────────────────────────────────────────── */
.chips-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 0;
}

.due-badge {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
  padding: 1px 4px;
  border-radius: 4px;
  background: var(--color-surface);
}

.due-badge--today {
  color: #f59e0b;
  background: rgba(245,158,11,0.1);
}

.due-badge--overdue {
  color: var(--color-danger);
  background: rgba(239,68,68,0.1);
}

.extra-contexts {
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.6;
}

.assignee-chip {
  display: inline-flex;
  align-items: center;
  background: rgba(91,141,239,0.12);
  color: #5b8def;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
}

.source-note-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.source-note-chip:hover {
  color: var(--color-accent);
  background: var(--color-hover);
}

/* ── Right side ───────────────────────────────────────────────────────────── */
.card-right {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: auto;
  opacity: 0;
  transition: opacity 0.1s;
}

.task-card:hover .card-right {
  opacity: 1;
}

/* Always show sub-task count even without hover */
.subtask-count {
  font-size: 10px;
  font-weight: 500;
  color: var(--color-text-muted);
  opacity: 0.7 !important;
}

.task-card:hover .subtask-count {
  opacity: 1 !important;
}

.subtask-count--all-done {
  color: #22c55e;
}

.btn-add-subtask {
  display: flex;
  align-items: center;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  border-radius: 4px;
  padding: 2px 5px;
  cursor: pointer;
  font-size: 11px;
}

.btn-add-subtask:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.waiting-icon {
  color: #8b5cf6;
  opacity: 0.7;
}

/* Override right-side opacity for sub-task count to always be visible */
.subtask-count {
  opacity: 1 !important;
}
</style>
