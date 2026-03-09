<script setup lang="ts">
import { ref, computed, reactive, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { CheckSquare, Plus, X, ChevronDown, ChevronRight, ArrowRight, Users } from 'lucide-vue-next'
import TaskCard from './TaskCard.vue'
import type { ActionItem } from './TaskCard.vue'
import SubTaskInput from './SubTaskInput.vue'
import GTDWeeklyReview from './GTDWeeklyReview.vue'
import type { OpenMode } from '../stores/tabStore'

const emit = defineEmits<{
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
  'open-settings': []
}>()

// ── Tab state ─────────────────────────────────────────────────────────────────
type Tab = 'inbox' | 'todo' | 'projects' | 'waiting' | 'delegated' | 'someday' | 'review'
const TABS: { id: Tab; label: string }[] = [
  { id: 'inbox',     label: 'Inbox' },
  { id: 'todo',      label: 'To Do' },
  { id: 'projects',  label: 'Projects' },
  { id: 'waiting',   label: 'Waiting For' },
  { id: 'delegated', label: 'Delegated' },
  { id: 'someday',   label: 'Someday' },
  { id: 'review',    label: 'Weekly Review' },
]
const STORAGE_TAB_KEY = 'wizz_actions_tab'
const STORAGE_COLLAPSE_KEY = 'wizz_actions_collapsed'

const activeTab = ref<Tab>((localStorage.getItem(STORAGE_TAB_KEY) as Tab | null) ?? 'inbox')
watch(activeTab, (tab) => localStorage.setItem(STORAGE_TAB_KEY, tab))

// ── Data ──────────────────────────────────────────────────────────────────────
const inboxTasks = ref<ActionItem[]>([])     // unprocessed: open/in_progress, no next-action flag, no assignee
const todoTasks = ref<ActionItem[]>([])      // is_next_action = 1
const waitingTasks = ref<ActionItem[]>([])
const somedayTasks = ref<ActionItem[]>([])
const delegatedTasks = ref<ActionItem[]>([]) // has assigned_entity_id
const projectTasks = ref<ActionItem[]>([])   // has project_entity_id (all statuses)
const loading = ref(true)

// Project entity type (for To Do kanban filter label)
const projectEntityTypeId = ref('')
type ProjectEntity = { id: string; name: string }
const projectEntities = ref<ProjectEntity[]>([])

// ── Filter state (To Do kanban) ───────────────────────────────────────────────
const filterContext = ref('')
const filterEnergy = ref<'low' | 'medium' | 'high' | ''>('')
const filterDueToday = ref(false)
const filterProjectId = ref<string | null>(null)

// ── Collapsed groups (Inbox) ──────────────────────────────────────────────────
const collapsedGroups = reactive(
  new Set<string>(JSON.parse(localStorage.getItem(STORAGE_COLLAPSE_KEY) ?? '[]') as string[]),
)
function toggleGroup(id: string): void {
  if (collapsedGroups.has(id)) collapsedGroups.delete(id)
  else collapsedGroups.add(id)
  localStorage.setItem(STORAGE_COLLAPSE_KEY, JSON.stringify([...collapsedGroups]))
}

// ── New task form ─────────────────────────────────────────────────────────────
const showNewForm = ref(false)
const newTitle = ref('')
const newFormInputRef = ref<HTMLInputElement | null>(null)

function openNewForm(): void {
  showNewForm.value = true
  nextTick(() => newFormInputRef.value?.focus())
}

function cancelNewForm(): void {
  showNewForm.value = false
  newTitle.value = ''
}

async function createTask(): Promise<void> {
  const t = newTitle.value.trim()
  if (!t) return
  const isInTodo = activeTab.value === 'todo'
  await window.api.invoke('action-items:create', {
    title: t,
    project_entity_id: filterProjectId.value || null,
    is_next_action: isInTodo,
  })
  newTitle.value = ''
  showNewForm.value = false
  await loadAll()
}

function onNewFormKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') void createTask()
  else if (e.key === 'Escape') cancelNewForm()
}

// ── Load data ─────────────────────────────────────────────────────────────────
async function loadInbox(): Promise<void> {
  // Inbox = open/in_progress tasks that haven't been processed into To Do, delegated, or someday
  inboxTasks.value = (await window.api.invoke('action-items:list', {
    status_multi: ['open', 'in_progress'],
    is_next_action: false,
    no_assignee: true,
    parent_id: null,
  })) as ActionItem[]
}

async function loadTodo(): Promise<void> {
  todoTasks.value = (await window.api.invoke('action-items:list', {
    is_next_action: true,
    parent_id: null,
  })) as ActionItem[]
}

async function loadWaiting(): Promise<void> {
  waitingTasks.value = (await window.api.invoke('action-items:list', {
    is_waiting_for: 1,
  })) as ActionItem[]
}

async function loadSomeday(): Promise<void> {
  somedayTasks.value = (await window.api.invoke('action-items:list', {
    status_multi: ['someday'],
  })) as ActionItem[]
}

async function loadDelegated(): Promise<void> {
  delegatedTasks.value = (await window.api.invoke('action-items:list', {
    has_assignee: true,
    status_multi: ['open', 'in_progress', 'someday'],
    parent_id: null,
  })) as ActionItem[]
}

async function loadProjectTasks(): Promise<void> {
  projectTasks.value = (await window.api.invoke('action-items:list', {
    has_project: true,
    status_multi: ['open', 'in_progress', 'done', 'someday'],
    parent_id: null,
  })) as ActionItem[]
}

async function loadProjectEntityType(): Promise<void> {
  const val = (await window.api.invoke('settings:get', { key: 'gtd_project_entity_type_id' })) as string | null
  projectEntityTypeId.value = val ?? ''
}

async function loadProjectEntities(): Promise<void> {
  if (!projectEntityTypeId.value) { projectEntities.value = []; return }
  projectEntities.value = (await window.api.invoke('entities:list', { type_id: projectEntityTypeId.value })) as ProjectEntity[]
}

async function loadAll(): Promise<void> {
  loading.value = true
  try {
    await Promise.all([
      loadInbox(),
      loadTodo(),
      loadWaiting(),
      loadSomeday(),
      loadDelegated(),
      loadProjectTasks(),
      loadProjectEntityType().then(() => loadProjectEntities()),
    ])
  } finally {
    loading.value = false
  }
}

// ── Mark as next action / remove from To Do ───────────────────────────────────
async function markAsNextAction(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:update', { id: task.id, is_next_action: true })
  await Promise.all([loadInbox(), loadTodo()])
}

async function unmarkNextAction(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:update', { id: task.id, is_next_action: false })
  await Promise.all([loadInbox(), loadTodo()])
}

async function moveToInbox(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:update', { id: task.id, is_next_action: false })
  await Promise.all([loadInbox(), loadTodo()])
}

// ── Inbox groups ──────────────────────────────────────────────────────────────
function parseContexts(raw: string): string[] {
  try { return JSON.parse(raw) as string[] }
  catch { return [] }
}

type Group = { id: string; name: string; tasks: ActionItem[] }

const inboxGroups = computed<Group[]>(() => {
  const inbox: ActionItem[] = []
  const byProject = new Map<string, Group>()
  for (const task of inboxTasks.value) {
    if (!task.project_entity_id) inbox.push(task)
    else {
      const key = task.project_entity_id
      if (!byProject.has(key)) byProject.set(key, { id: key, name: task.project_name ?? key, tasks: [] })
      byProject.get(key)!.tasks.push(task)
    }
  }
  const result: Group[] = []
  if (inbox.length > 0 || byProject.size === 0) result.push({ id: '__inbox__', name: 'No project', tasks: inbox })
  result.push(...Array.from(byProject.values()))
  return result
})

// ── To Do kanban columns ──────────────────────────────────────────────────────
const todoFiltered = computed(() =>
  todoTasks.value.filter((t) => {
    if (filterProjectId.value && t.project_entity_id !== filterProjectId.value) return false
    if (filterContext.value) {
      const ctxs = parseContexts(t.contexts)
      if (!ctxs.some((c) => c.toLowerCase().includes(filterContext.value.toLowerCase()))) return false
    }
    if (filterEnergy.value && t.energy_level !== filterEnergy.value) return false
    if (filterDueToday.value) {
      const today = new Date().toISOString().slice(0, 10)
      if (t.due_date !== today) return false
    }
    return true
  })
)

const todoOpen = computed(() => todoFiltered.value.filter((t) => t.status === 'open'))
const todoInProgress = computed(() => todoFiltered.value.filter((t) => t.status === 'in_progress'))
const todoDone = computed(() => todoFiltered.value.filter((t) => t.status === 'done'))

const availableContexts = computed<string[]>(() => {
  const s = new Set<string>()
  for (const t of todoTasks.value) for (const c of parseContexts(t.contexts)) s.add(c)
  return [...s].sort()
})

// ── Drag and drop (To Do kanban) ──────────────────────────────────────────────
const draggingId = ref<string | null>(null)
const dragOverColumn = ref<string | null>(null)

function onDragStart(e: DragEvent, task: ActionItem): void {
  draggingId.value = task.id
  e.dataTransfer?.setData('text/plain', task.id)
}

function onDragOver(e: DragEvent, column: string): void {
  e.preventDefault()
  dragOverColumn.value = column
}

function onDragLeave(): void {
  dragOverColumn.value = null
}

async function onDrop(e: DragEvent, column: 'open' | 'in_progress' | 'done'): Promise<void> {
  e.preventDefault()
  dragOverColumn.value = null
  const id = draggingId.value
  if (!id) return
  draggingId.value = null
  await window.api.invoke('action-items:update', { id, status: column })
  await loadTodo()
}

function onDragEnd(): void {
  draggingId.value = null
  dragOverColumn.value = null
}

// ── Project groups (Projects tab) ──────────────────────────────────────────────
type ProjectGroup = { id: string; name: string; tasks: ActionItem[] }

const projectGroups = computed<ProjectGroup[]>(() => {
  const map = new Map<string, ProjectGroup>()
  for (const t of projectTasks.value) {
    const key = t.project_entity_id ?? '__none__'
    const name = t.project_name ?? key
    if (!map.has(key)) map.set(key, { id: key, name, tasks: [] })
    map.get(key)!.tasks.push(t)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})

// ── Waiting groups ────────────────────────────────────────────────────────────
type WaitingGroup = { name: string; tasks: ActionItem[] }

const waitingGroups = computed<WaitingGroup[]>(() => {
  const map = new Map<string, WaitingGroup>()
  for (const t of waitingTasks.value) {
    const key = t.waiting_for_entity_id ?? '__anyone__'
    const name = t.waiting_for_entity_name ?? 'Anyone'
    if (!map.has(key)) map.set(key, { name, tasks: [] })
    map.get(key)!.tasks.push(t)
  }
  return [...map.values()]
})

// ── Delegated groups ──────────────────────────────────────────────────────────
type DelegatedGroup = { entityId: string; name: string; tasks: ActionItem[] }

const delegatedGroups = computed<DelegatedGroup[]>(() => {
  const map = new Map<string, DelegatedGroup>()
  for (const t of delegatedTasks.value) {
    const key = t.assigned_entity_id ?? '__unknown__'
    const name = t.assigned_entity_name ?? 'Unknown'
    if (!map.has(key)) map.set(key, { entityId: key, name, tasks: [] })
    map.get(key)!.tasks.push(t)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})

// ── Someday ───────────────────────────────────────────────────────────────────
async function activateSomeday(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:update', { id: task.id, status: 'open' })
  somedayTasks.value = somedayTasks.value.filter((t) => t.id !== task.id)
  await loadInbox()
}

async function deleteSomeday(task: ActionItem): Promise<void> {
  await window.api.invoke('action-items:delete', { id: task.id })
  somedayTasks.value = somedayTasks.value.filter((t) => t.id !== task.id)
}

// ── Status changes from TaskCard ──────────────────────────────────────────────
function onStatusChanged(taskId: string, status: ActionItem['status']): void {
  const update = (list: ActionItem[]) => {
    const i = list.findIndex((t) => t.id === taskId)
    if (i !== -1) list[i] = { ...list[i], status }
  }
  update(inboxTasks.value)
  update(todoTasks.value)
  update(waitingTasks.value)
  update(delegatedTasks.value)
  update(somedayTasks.value)
  if (status === 'done' || status === 'cancelled') {
    inboxTasks.value = inboxTasks.value.filter((t) => t.id !== taskId)
    todoTasks.value = todoTasks.value.filter((t) => t.id !== taskId)
    delegatedTasks.value = delegatedTasks.value.filter((t) => t.id !== taskId)
  }
  if (status === 'someday') {
    const t = inboxTasks.value.find((x) => x.id === taskId)
    inboxTasks.value = inboxTasks.value.filter((x) => x.id !== taskId)
    todoTasks.value = todoTasks.value.filter((x) => x.id !== taskId)
    if (t) somedayTasks.value = [...somedayTasks.value, { ...t, status }]
  }
}

function onSubtaskCreated(): void { void loadAll() }
function onProjectStatusChanged(taskId: string, status: ActionItem['status']): void {
  const i = projectTasks.value.findIndex((t) => t.id === taskId)
  if (i !== -1) projectTasks.value[i] = { ...projectTasks.value[i], status }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function ageLabel(task: ActionItem): string {
  const d = task.updated_at ? new Date(task.updated_at) : new Date(task.created_at)
  const days = Math.floor((Date.now() - d.getTime()) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return '1d ago'
  return `${days}d ago`
}

function fmtDue(date: string | null): string {
  if (!date) return ''
  return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function isDueOverdue(date: string | null): boolean {
  if (!date) return false
  return date < new Date().toISOString().slice(0, 10)
}

// ── Push events ───────────────────────────────────────────────────────────────
const unsubs = [
  window.api.on('action:created', () => void loadAll()),
  window.api.on('action:status-changed', () => void loadAll()),
  window.api.on('action:updated', () => void loadAll()),
  window.api.on('action:deleted', () => void loadAll()),
  window.api.on('note:actions-complete', () => void loadAll()),
]

onMounted(() => void loadAll())
onBeforeUnmount(() => unsubs.forEach((fn) => fn()))
</script>

<template>
  <div class="actions-view">

    <!-- ── Header ─────────────────────────────────────────────────────────── -->
    <div class="actions-header">
      <div class="actions-title">
        <CheckSquare :size="15" />
        <h2>Actions</h2>
      </div>
      <button class="btn-new-task" @click="openNewForm">
        <Plus :size="13" /> New Task
      </button>
    </div>

    <!-- ── Inline new-task form ───────────────────────────────────────────── -->
    <div v-if="showNewForm" class="new-form">
      <input
        ref="newFormInputRef"
        v-model="newTitle"
        class="new-form-input"
        placeholder="Task title…"
        @keydown="onNewFormKeydown"
      />
      <button class="btn-submit" :disabled="!newTitle.trim()" @click="createTask">Add</button>
      <button class="btn-cancel-form" @click="cancelNewForm"><X :size="12" /></button>
    </div>

    <!-- ── Tab bar ────────────────────────────────────────────────────────── -->
    <div class="tab-bar">
      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="tab-btn"
        :class="{ 'tab-btn--active': activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
        <span v-if="tab.id === 'inbox' && !loading" class="tab-count">{{ inboxTasks.length }}</span>
        <span v-if="tab.id === 'todo' && !loading" class="tab-count">{{ todoTasks.filter(t => t.status !== 'done').length }}</span>
        <span v-if="tab.id === 'waiting' && !loading" class="tab-count">{{ waitingTasks.length }}</span>
        <span v-if="tab.id === 'delegated' && !loading" class="tab-count">{{ delegatedTasks.length }}</span>
        <span v-if="tab.id === 'someday' && !loading" class="tab-count">{{ somedayTasks.length }}</span>
      </button>
    </div>

    <div v-if="loading" class="tab-loading">Loading…</div>

    <div v-else class="tab-content" :class="{ 'tab-content--kanban': activeTab === 'todo' }">

      <!-- ════════════════════════════════════════════════════════════════
           Tab: Inbox — all non-done tasks
      ══════════════════════════════════════════════════════════════════ -->
      <template v-if="activeTab === 'inbox'">
        <div v-if="inboxTasks.length === 0" class="empty-state">
          <CheckSquare :size="28" class="empty-icon" />
          <h3>Inbox clear!</h3>
          <p>All tasks are done or in your To Do list.</p>
        </div>

        <div v-else class="groups-list">
          <div v-for="group in inboxGroups" :key="group.id" class="group">
            <button class="group-header" @click="toggleGroup(group.id)">
              <component :is="collapsedGroups.has(group.id) ? ChevronRight : ChevronDown" :size="13" />
              <span class="group-name">{{ group.name }}</span>
              <span class="group-count">{{ group.tasks.length }}</span>
            </button>
            <div v-if="!collapsedGroups.has(group.id)" class="group-tasks">
              <div v-for="task in group.tasks" :key="task.id" class="inbox-row">
                <TaskCard
                  :task="task"
                  :show-project="group.id !== '__inbox__'"
                  :show-source-note="true"
                  class="inbox-card"
                  @open-note="emit('open-note', $event)"
                  @status-changed="onStatusChanged"
                  @subtask-created="onSubtaskCreated"
                />
                <button
                  class="btn-next-action"
                  :class="{ 'btn-next-action--active': task.is_next_action === 1 }"
                  title="Mark as To Do"
                  @click="task.is_next_action === 1 ? unmarkNextAction(task) : markAsNextAction(task)"
                >
                  <ArrowRight :size="13" />
                  {{ task.is_next_action === 1 ? 'In To Do' : 'To Do' }}
                </button>
              </div>
              <p v-if="group.tasks.length === 0" class="group-empty">No tasks</p>
            </div>
          </div>
        </div>
      </template>

      <!-- ════════════════════════════════════════════════════════════════
           Tab: To Do — kanban board (next actions)
      ══════════════════════════════════════════════════════════════════ -->
      <template v-else-if="activeTab === 'todo'">

        <!-- Filter bar -->
        <div class="filter-bar">
          <button
            v-if="filterProjectId"
            class="filter-chip filter-chip--active"
            @click="filterProjectId = null"
          >
            {{ projectEntities.find(p => p.id === filterProjectId)?.name ?? 'Project' }}
            <X :size="10" />
          </button>
          <div class="filter-contexts">
            <button
              v-for="ctx in availableContexts"
              :key="ctx"
              class="filter-chip"
              :class="{ 'filter-chip--active': filterContext === ctx }"
              @click="filterContext = filterContext === ctx ? '' : ctx"
            >{{ ctx }}</button>
          </div>
          <div class="energy-filter">
            <button
              v-for="e in (['low','medium','high'] as const)"
              :key="e"
              class="energy-pill"
              :class="{ 'energy-pill--active': filterEnergy === e, [`energy-pill--${e}`]: true }"
              @click="filterEnergy = filterEnergy === e ? '' : e"
            >{{ e[0].toUpperCase() + e.slice(1) }}</button>
          </div>
          <button
            class="filter-chip"
            :class="{ 'filter-chip--active': filterDueToday }"
            @click="filterDueToday = !filterDueToday"
          >Due today</button>
          <button
            v-if="filterContext || filterEnergy || filterDueToday || filterProjectId"
            class="btn-clear-filters"
            @click="filterContext = ''; filterEnergy = ''; filterDueToday = false; filterProjectId = null"
          >Clear filters</button>
        </div>

        <!-- Kanban columns -->
        <div v-if="todoTasks.length === 0" class="empty-state">
          <CheckSquare :size="28" class="empty-icon" />
          <h3>No items in To Do</h3>
          <p>Mark tasks as "To Do" from the Inbox tab to see them here.</p>
        </div>

        <div v-else class="kanban-board">
          <!-- To Do column -->
          <div
            class="kanban-col"
            :class="{ 'kanban-col--dragover': dragOverColumn === 'open' }"
            @dragover="onDragOver($event, 'open')"
            @dragleave="onDragLeave"
            @drop="onDrop($event, 'open')"
          >
            <div class="kanban-col-header">
              <span class="kanban-col-title">To Do</span>
              <span class="kanban-col-count">{{ todoOpen.length }}</span>
            </div>
            <div class="kanban-col-tasks">
              <div
                v-for="task in todoOpen"
                :key="task.id"
                class="kanban-card-wrap"
                :class="{ 'kanban-card-wrap--dragging': draggingId === task.id }"
                draggable="true"
                @dragstart="onDragStart($event, task)"
                @dragend="onDragEnd"
              >
                <TaskCard
                  :task="task"
                  :show-project="true"
                  :show-source-note="true"
                  @open-note="emit('open-note', $event)"
                  @status-changed="onStatusChanged"
                  @subtask-created="onSubtaskCreated"
                />
                <button class="btn-back-inbox" title="Move back to Inbox" @click.stop="moveToInbox(task)">← Inbox</button>
              </div>
              <p v-if="todoOpen.length === 0" class="kanban-empty">Drop tasks here</p>
            </div>
          </div>

          <!-- In Progress column -->
          <div
            class="kanban-col"
            :class="{ 'kanban-col--dragover': dragOverColumn === 'in_progress' }"
            @dragover="onDragOver($event, 'in_progress')"
            @dragleave="onDragLeave"
            @drop="onDrop($event, 'in_progress')"
          >
            <div class="kanban-col-header">
              <span class="kanban-col-title">In Progress</span>
              <span class="kanban-col-count">{{ todoInProgress.length }}</span>
            </div>
            <div class="kanban-col-tasks">
              <div
                v-for="task in todoInProgress"
                :key="task.id"
                class="kanban-card-wrap"
                :class="{ 'kanban-card-wrap--dragging': draggingId === task.id }"
                draggable="true"
                @dragstart="onDragStart($event, task)"
                @dragend="onDragEnd"
              >
                <TaskCard
                  :task="task"
                  :show-project="true"
                  :show-source-note="true"
                  @open-note="emit('open-note', $event)"
                  @status-changed="onStatusChanged"
                  @subtask-created="onSubtaskCreated"
                />
                <button class="btn-back-inbox" title="Move back to Inbox" @click.stop="moveToInbox(task)">← Inbox</button>
              </div>
              <p v-if="todoInProgress.length === 0" class="kanban-empty">Drop tasks here</p>
            </div>
          </div>

          <!-- Done column -->
          <div
            class="kanban-col"
            :class="{ 'kanban-col--dragover': dragOverColumn === 'done' }"
            @dragover="onDragOver($event, 'done')"
            @dragleave="onDragLeave"
            @drop="onDrop($event, 'done')"
          >
            <div class="kanban-col-header">
              <span class="kanban-col-title">Done</span>
              <span class="kanban-col-count">{{ todoDone.length }}</span>
            </div>
            <div class="kanban-col-tasks">
              <div
                v-for="task in todoDone"
                :key="task.id"
                class="kanban-card-wrap"
                :class="{ 'kanban-card-wrap--dragging': draggingId === task.id }"
                draggable="true"
                @dragstart="onDragStart($event, task)"
                @dragend="onDragEnd"
              >
                <TaskCard
                  :task="task"
                  :show-project="true"
                  :show-source-note="true"
                  @open-note="emit('open-note', $event)"
                  @status-changed="onStatusChanged"
                  @subtask-created="onSubtaskCreated"
                />
              </div>
              <p v-if="todoDone.length === 0" class="kanban-empty">Drop tasks here</p>
            </div>
          </div>
        </div>
      </template>

      <!-- ════════════════════════════════════════════════════════════════
           Tab: Projects
      ══════════════════════════════════════════════════════════════════ -->
      <template v-else-if="activeTab === 'projects'">
        <div v-if="projectGroups.length === 0" class="empty-state">
          <CheckSquare :size="28" class="empty-icon" />
          <h3>No project tasks</h3>
          <p>Assign tasks to a project to see them grouped here.</p>
        </div>
        <div v-else class="groups-list">
          <div v-for="group in projectGroups" :key="group.id" class="group">
            <button class="group-header" @click="toggleGroup('proj-' + group.id)">
              <component :is="collapsedGroups.has('proj-' + group.id) ? ChevronRight : ChevronDown" :size="13" />
              <span class="group-name">{{ group.name }}</span>
              <span class="group-count">{{ group.tasks.length }}</span>
            </button>
            <div v-if="!collapsedGroups.has('proj-' + group.id)" class="group-tasks">
              <TaskCard
                v-for="task in group.tasks"
                :key="task.id"
                :task="task"
                :show-project="false"
                :show-source-note="true"
                @open-note="emit('open-note', $event)"
                @status-changed="onProjectStatusChanged"
                @subtask-created="onSubtaskCreated"
              />
            </div>
          </div>
        </div>
      </template>

      <!-- ════════════════════════════════════════════════════════════════
           Tab: Waiting For
      ══════════════════════════════════════════════════════════════════ -->
      <template v-else-if="activeTab === 'waiting'">
        <div v-if="waitingGroups.length === 0" class="empty-state">
          <CheckSquare :size="28" class="empty-icon" />
          <h3>Nothing waiting</h3>
          <p>No tasks are blocked on someone else right now.</p>
        </div>
        <div v-else class="waiting-groups">
          <div v-for="group in waitingGroups" :key="group.name" class="waiting-group">
            <div class="waiting-group-header">
              Waiting on <strong>{{ group.name }}</strong>
              <span class="group-count">{{ group.tasks.length }}</span>
            </div>
            <div class="group-tasks">
              <div v-for="task in group.tasks" :key="task.id" class="waiting-row">
                <TaskCard
                  :task="task"
                  :show-project="true"
                  :show-source-note="true"
                  class="inbox-card"
                  @open-note="emit('open-note', $event)"
                  @status-changed="onStatusChanged"
                  @subtask-created="onSubtaskCreated"
                />
                <span class="age-label">{{ ageLabel(task) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ════════════════════════════════════════════════════════════════
           Tab: Delegated
      ══════════════════════════════════════════════════════════════════ -->
      <template v-else-if="activeTab === 'delegated'">
        <div v-if="delegatedGroups.length === 0" class="empty-state">
          <Users :size="28" class="empty-icon" />
          <h3>No delegated tasks</h3>
          <p>Tasks assigned to someone will appear here.</p>
        </div>
        <div v-else class="delegated-groups">
          <div v-for="group in delegatedGroups" :key="group.entityId" class="delegated-group">
            <div class="delegated-group-header">
              <Users :size="12" class="delegated-group-icon" />
              <span class="delegated-group-name">{{ group.name }}</span>
              <span class="group-count">{{ group.tasks.length }}</span>
            </div>
            <div class="group-tasks">
              <div v-for="task in group.tasks" :key="task.id" class="delegated-row">
                <TaskCard
                  :task="task"
                  :show-project="true"
                  :show-source-note="true"
                  @open-note="emit('open-note', $event)"
                  @status-changed="onStatusChanged"
                  @subtask-created="onSubtaskCreated"
                />
                <span class="age-label">{{ ageLabel(task) }}</span>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- ════════════════════════════════════════════════════════════════
           Tab: Someday
      ══════════════════════════════════════════════════════════════════ -->
      <template v-else-if="activeTab === 'someday'">
        <div v-if="somedayTasks.length === 0" class="empty-state">
          <CheckSquare :size="28" class="empty-icon" />
          <h3>No someday items</h3>
          <p>Tasks with status "Someday" will appear here.</p>
        </div>
        <div v-else class="someday-list">
          <div v-for="task in somedayTasks" :key="task.id" class="someday-row">
            <span class="someday-title">{{ task.title }}</span>
            <span v-if="task.project_name" class="someday-project">{{ task.project_name }}</span>
            <div class="someday-actions">
              <button class="btn-activate" @click="activateSomeday(task)">Activate</button>
              <button class="btn-delete" @click="deleteSomeday(task)">Delete</button>
            </div>
          </div>
        </div>
      </template>

      <!-- ════════════════════════════════════════════════════════════════
           Tab: Weekly Review
      ══════════════════════════════════════════════════════════════════ -->
      <template v-else-if="activeTab === 'review'">
        <GTDWeeklyReview @open-note="emit('open-note', $event)" />
      </template>

    </div>
  </div>
</template>

<style scoped>
.actions-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  height: 100%;
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.actions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 28px 12px;
  flex-shrink: 0;
}

.actions-title {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--color-text);
}

.actions-title h2 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.btn-new-task {
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
.btn-new-task:hover { opacity: 0.9; }

/* ── New task form ────────────────────────────────────────────────────────── */
.new-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 28px 8px;
  padding: 8px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  flex-shrink: 0;
}

.new-form-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
}
.new-form-input::placeholder { color: var(--color-text-muted); }

.btn-submit {
  padding: 4px 10px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  font-weight: 500;
}
.btn-submit:disabled { opacity: 0.4; cursor: default; }

.btn-cancel-form {
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
}
.btn-cancel-form:hover { color: var(--color-text); }

/* ── Tab bar ──────────────────────────────────────────────────────────────── */
.tab-bar {
  display: flex;
  align-items: center;
  padding: 0 28px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  overflow-x: auto;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 9px 14px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.1s, border-color 0.1s;
  margin-bottom: -1px;
}
.tab-btn:hover { color: var(--color-text); }
.tab-btn--active { color: var(--color-accent); border-bottom-color: var(--color-accent); }

.tab-count {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  font-size: 10px;
  font-weight: 600;
  padding: 0 5px;
  min-width: 18px;
  text-align: center;
  color: var(--color-text-muted);
}

/* ── Tab content ──────────────────────────────────────────────────────────── */
.tab-loading {
  padding: 32px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-muted);
}

.tab-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 28px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
}

.tab-content--kanban {
  overflow-y: hidden;
  padding: 16px 20px 16px;
}

/* ── Inbox rows ───────────────────────────────────────────────────────────── */
.inbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.inbox-card {
  flex: 1;
  min-width: 0;
}

.btn-next-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 9px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 0.1s, background 0.1s, color 0.1s;
}

.inbox-row:hover .btn-next-action { opacity: 1; }

.btn-next-action:hover {
  background: rgba(91,141,239,0.1);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.btn-next-action--active {
  opacity: 1 !important;
  background: rgba(91,141,239,0.12);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

/* ── Filter bar ───────────────────────────────────────────────────────────── */
.filter-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  flex-shrink: 0;
}

.filter-contexts { display: flex; gap: 4px; flex-wrap: wrap; }

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.filter-chip:hover { border-color: var(--color-accent); color: var(--color-accent); }
.filter-chip--active {
  background: rgba(91,141,239,0.12);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.energy-filter { display: flex; gap: 2px; }
.energy-pill {
  padding: 3px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
}
.energy-pill--low.energy-pill--active    { background: rgba(59,130,246,0.12); color: #3b82f6; border-color: #3b82f6; }
.energy-pill--medium.energy-pill--active { background: rgba(245,158,11,0.12); color: #f59e0b; border-color: #f59e0b; }
.energy-pill--high.energy-pill--active   { background: var(--color-danger-subtle); color: var(--color-danger); border-color: var(--color-danger); }
.energy-pill:hover { border-color: var(--color-accent); color: var(--color-accent); }

.btn-clear-filters {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 3px 4px;
  text-decoration: underline;
}
.btn-clear-filters:hover { color: var(--color-text); }

/* ── Kanban board ─────────────────────────────────────────────────────────── */
.kanban-board {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.kanban-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
  transition: border-color 0.15s;
}

.kanban-col--dragover {
  border-color: var(--color-accent);
  background: rgba(91,141,239,0.04);
}

.kanban-col-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.kanban-col-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.kanban-col-count {
  font-size: 11px;
  color: var(--color-text-muted);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0 5px;
  min-width: 16px;
  text-align: center;
}

.kanban-col-tasks {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.kanban-card-wrap {
  cursor: grab;
  border-radius: 8px;
  transition: opacity 0.15s;
  display: flex;
  flex-direction: column;
}

.kanban-card-wrap:active { cursor: grabbing; }
.kanban-card-wrap--dragging { opacity: 0.4; }

.kanban-empty {
  text-align: center;
  font-size: 12px;
  color: var(--color-text-muted);
  opacity: 0.45;
  padding: 16px 8px;
  margin: 0;
}

.btn-back-inbox {
  display: none;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 10px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 6px;
  white-space: nowrap;
  flex-shrink: 0;
  margin-top: 4px;
  align-self: flex-end;
}
.kanban-card-wrap:hover .btn-back-inbox { display: block; }
.btn-back-inbox:hover { color: var(--color-accent); border-color: var(--color-accent); }

/* ── Groups (Inbox) ───────────────────────────────────────────────────────── */
.groups-list { display: flex; flex-direction: column; gap: 16px; }
.group { display: flex; flex-direction: column; gap: 4px; }

.group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 4px 0;
  color: var(--color-text-muted);
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  text-align: left;
}
.group-header:hover { color: var(--color-text); }
.group-name { flex: 1; }

.group-count {
  font-size: 10px;
  font-weight: 400;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 0 5px;
  min-width: 16px;
  text-align: center;
}

.group-tasks { display: flex; flex-direction: column; gap: 4px; }
.group-empty { font-size: 12px; color: var(--color-text-muted); opacity: 0.45; margin: 0; padding: 4px 2px; }

/* ── Empty state ──────────────────────────────────────────────────────────── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 24px;
  text-align: center;
}
.empty-icon { color: var(--color-text-muted); opacity: 0.25; margin-bottom: 4px; }
.empty-state h3 { font-size: 15px; font-weight: 600; margin: 0; color: var(--color-text); }
.empty-state p { font-size: 13px; color: var(--color-text-muted); margin: 0; max-width: 300px; line-height: 1.5; }


/* ── Waiting tab ──────────────────────────────────────────────────────────── */
.waiting-groups { display: flex; flex-direction: column; gap: 20px; }
.waiting-group { display: flex; flex-direction: column; gap: 6px; }
.waiting-group-header {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
}
.waiting-row { display: flex; align-items: center; gap: 10px; }
.waiting-row > :first-child { flex: 1; min-width: 0; }
.age-label { font-size: 11px; color: var(--color-text-muted); white-space: nowrap; flex-shrink: 0; opacity: 0.6; }

/* ── Delegated tab ────────────────────────────────────────────────────────── */
.delegated-groups { display: flex; flex-direction: column; gap: 20px; }
.delegated-group { display: flex; flex-direction: column; gap: 6px; }

.delegated-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--color-border);
}
.delegated-group-icon { flex-shrink: 0; }
.delegated-group-name { flex: 1; }

.delegated-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.delegated-row > :first-child { flex: 1; min-width: 0; }

/* ── Someday tab ──────────────────────────────────────────────────────────── */
.someday-list { display: flex; flex-direction: column; gap: 4px; }
.someday-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 7px;
}
.someday-title { flex: 1; font-size: 13px; color: var(--color-text); opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.someday-project { font-size: 11px; color: #f0a050; background: rgba(240,160,80,0.1); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.someday-actions { display: flex; gap: 6px; flex-shrink: 0; opacity: 0; transition: opacity 0.1s; }
.someday-row:hover .someday-actions { opacity: 1; }

.btn-activate {
  padding: 3px 8px;
  background: rgba(34,197,94,0.1);
  color: #22c55e;
  border: 1px solid rgba(34,197,94,0.25);
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}
.btn-activate:hover { background: rgba(34,197,94,0.2); }

.btn-delete {
  padding: 3px 8px;
  background: transparent;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}
.btn-delete:hover { background: var(--color-danger-subtle); color: var(--color-danger); border-color: var(--color-danger-border); }
</style>
