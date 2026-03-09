<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { X, FileText, ExternalLink, Plus, Check, Trash2 } from 'lucide-vue-next'
import TaskAttributeChip from './TaskAttributeChip.vue'
import SubTaskInput from './SubTaskInput.vue'
import TaskCard from './TaskCard.vue'
import type { ActionItem } from './TaskCard.vue'
import type { OpenMode } from '../stores/tabStore'

const props = defineProps<{
  taskId: string
}>()

const emit = defineEmits<{
  close: []
  'open-note': [payload: { noteId: string; title: string; mode: OpenMode }]
  'open-actions': []
  deleted: [taskId: string]
}>()

// ── Task state ────────────────────────────────────────────────────────────────
const task = ref<ActionItem | null>(null)
const subTasks = ref<ActionItem[]>([])
const loading = ref(false)
const saving = ref(false)

// ── Edit state ────────────────────────────────────────────────────────────────
const editTitle = ref('')
const editBody = ref('')
const editStatus = ref<ActionItem['status']>('open')
const editDueDate = ref('')
const editEnergyLevel = ref<'low' | 'medium' | 'high' | ''>('')
const editIsWaitingFor = ref(false)
const editContextInput = ref('')
const editContexts = ref<string[]>([])

// Assigned entity
const editAssignedId = ref<string | null>(null)
const editAssignedName = ref<string | null>(null)

// Project entity
const editProjectId = ref<string | null>(null)
const editProjectName = ref<string | null>(null)
const projectEntityTypeId = ref('')

// Waiting-for entity
const editWaitingForId = ref<string | null>(null)
const editWaitingForName = ref<string | null>(null)

// ── Entity search dropdowns ───────────────────────────────────────────────────
type EntityResult = { id: string; name: string }

const projectSearch = ref('')
const projectResults = ref<EntityResult[]>([])
const projectDropdownOpen = ref(false)

const assigneeSearch = ref('')
const assigneeResults = ref<EntityResult[]>([])
const assigneeDropdownOpen = ref(false)

const waitingSearch = ref('')
const waitingResults = ref<EntityResult[]>([])
const waitingDropdownOpen = ref(false)

// ── Sub-task input ────────────────────────────────────────────────────────────
const showSubTaskInput = ref(false)
const subTaskInputRef = ref<InstanceType<typeof SubTaskInput> | null>(null)

// ── Delete confirm ────────────────────────────────────────────────────────────
const confirmDelete = ref(false)

// ── Context autocomplete ──────────────────────────────────────────────────────
const rememberedContexts = ref<string[]>([])
const contextSuggestions = ref<string[]>([])
const contextDropdownOpen = ref(false)

// ── Load task ─────────────────────────────────────────────────────────────────
async function loadTask(silent = false): Promise<void> {
  if (!props.taskId) return
  if (!silent) loading.value = true
  try {
    const result = await window.api.invoke('action-items:get', { id: props.taskId }) as ActionItem | null
    if (!result) return
    task.value = result

    // Skip populating edit fields if a save is in progress — avoids overwriting
    // local edits with stale data from a concurrent push-triggered reload.
    if (saving.value) return

    // Populate edit state
    editTitle.value = result.title
    editBody.value = ''
    editStatus.value = result.status
    editDueDate.value = result.due_date ?? ''
    editEnergyLevel.value = result.energy_level ?? ''
    editIsWaitingFor.value = result.is_waiting_for === 1
    editAssignedId.value = result.assigned_entity_id
    editAssignedName.value = result.assigned_entity_name
    editProjectId.value = result.project_entity_id
    editProjectName.value = result.project_name
    editWaitingForId.value = result.waiting_for_entity_id
    editWaitingForName.value = result.waiting_for_entity_name

    editContexts.value = parseContexts(result.contexts)

    // Load sub-tasks
    await loadSubTasks()
  } finally {
    loading.value = false
  }
}

async function loadSubTasks(): Promise<void> {
  if (!props.taskId) return
  subTasks.value = (await window.api.invoke('action-items:list', {
    parent_id: props.taskId,
  })) as ActionItem[]
}

// Load project entity type from settings (needed for entity search type filter)
async function loadProjectEntityType(): Promise<void> {
  const val = await window.api.invoke('settings:get', { key: 'gtd_project_entity_type_id' }) as string | null
  projectEntityTypeId.value = val ?? ''
}

async function loadRememberedContexts(): Promise<void> {
  const raw = await window.api.invoke('settings:get', { key: 'gtd_contexts' }) as string | null
  try {
    rememberedContexts.value = raw ? (JSON.parse(raw) as string[]) : []
  } catch {
    rememberedContexts.value = []
  }
}

async function persistRememberedContext(ctx: string): Promise<void> {
  if (!ctx || rememberedContexts.value.includes(ctx)) return
  rememberedContexts.value = [...rememberedContexts.value, ctx].sort()
  await window.api.invoke('settings:set', { key: 'gtd_contexts', value: JSON.stringify(rememberedContexts.value) })
}

/** Safely parse contexts whether stored as a proper JSON array or as a double-serialized string (legacy bug). */
function parseContexts(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[]
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    // Handle double-serialization: if parse result is a string, parse again
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed) as string[] } catch { return [] }
    }
    return Array.isArray(parsed) ? parsed as string[] : []
  } catch {
    return []
  }
}

watch(() => props.taskId, () => loadTask(), { immediate: true })
onMounted(() => {
  void loadProjectEntityType()
  void loadRememberedContexts()
})

// Live sync: reload when this task is updated from elsewhere (e.g. ActionsView status change,
// AI derivation, or another panel edit). Skip if currently saving to avoid race conditions.
const unsubUpdated = window.api.on(
  'action:updated',
  (...args: unknown[]) => {
    const payload = args[0] as { actionId: string } | undefined
    if (payload?.actionId === props.taskId && !saving.value) {
      void loadTask(true)  // silent: no loading spinner
    }
  },
)
onBeforeUnmount(() => unsubUpdated())

// ── Save helpers ──────────────────────────────────────────────────────────────
async function saveField(fields: Record<string, unknown>): Promise<void> {
  if (!task.value) return
  saving.value = true
  try {
    await window.api.invoke('action-items:update', { id: task.value.id, ...fields })
    // Refresh task for derived fields (e.g. project_name, entity names)
    const updated = await window.api.invoke('action-items:get', { id: task.value.id }) as ActionItem | null
    if (updated) task.value = updated
  } finally {
    saving.value = false
  }
}

async function onTitleBlur(): Promise<void> {
  if (!task.value || editTitle.value === task.value.title) return
  await saveField({ title: editTitle.value.trim() || task.value.title })
}

async function onTitleKeydown(e: KeyboardEvent): Promise<void> {
  if (e.key === 'Enter') {
    e.preventDefault()
    ;(e.target as HTMLInputElement).blur()
  }
}

async function onStatusChange(): Promise<void> {
  await saveField({ status: editStatus.value })
}

async function onDueDateChange(): Promise<void> {
  await saveField({ due_date: editDueDate.value || null })
}

async function onEnergyChange(level: 'low' | 'medium' | 'high' | ''): Promise<void> {
  editEnergyLevel.value = level
  await saveField({ energy_level: level || null })
}

async function onWaitingToggle(): Promise<void> {
  editIsWaitingFor.value = !editIsWaitingFor.value
  if (!editIsWaitingFor.value) {
    editWaitingForId.value = null
    editWaitingForName.value = null
    await saveField({ is_waiting_for: 0, waiting_for_entity_id: null })
  } else {
    await saveField({ is_waiting_for: 1 })
  }
}

// ── Context tags ──────────────────────────────────────────────────────────────
async function addContext(ctx?: string): Promise<void> {
  const value = (ctx ?? editContextInput.value).trim()
  if (!value) {
    contextDropdownOpen.value = false
    return
  }
  if (!editContexts.value.includes(value)) {
    editContexts.value = [...editContexts.value, value]
    // Pass array directly — IPC handler serializes it
    await saveField({ contexts: [...editContexts.value] })
    void persistRememberedContext(value)
  }
  editContextInput.value = ''
  contextDropdownOpen.value = false
}

async function removeContext(ctx: string): Promise<void> {
  editContexts.value = editContexts.value.filter((c) => c !== ctx)
  await saveField({ contexts: [...editContexts.value] })
}

function onContextInput(): void {
  const q = editContextInput.value.trim().toLowerCase()
  const existing = new Set(editContexts.value)
  if (!q) {
    contextSuggestions.value = rememberedContexts.value.filter((c) => !existing.has(c))
  } else {
    contextSuggestions.value = rememberedContexts.value.filter(
      (c) => !existing.has(c) && c.toLowerCase().includes(q),
    )
  }
  contextDropdownOpen.value = contextSuggestions.value.length > 0 || q.length > 0
}

function onContextKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    void addContext()
  } else if (e.key === 'Escape') {
    contextDropdownOpen.value = false
  }
}

function onContextFocus(): void {
  onContextInput()
}

// ── Project entity search ─────────────────────────────────────────────────────
async function onProjectSearchInput(): Promise<void> {
  if (projectSearch.value.length < 1) {
    projectResults.value = []
    return
  }
  const results = await window.api.invoke('entities:search', {
    query: projectSearch.value,
    type_id: projectEntityTypeId.value || undefined,
  }) as EntityResult[]
  projectResults.value = results
}

function openProjectDropdown(): void {
  projectSearch.value = ''
  projectResults.value = []
  projectDropdownOpen.value = true
  nextTick(() => document.getElementById('tdp-project-search')?.focus())
}

function closeProjectDropdown(): void {
  projectDropdownOpen.value = false
  projectSearch.value = ''
}

async function selectProject(entity: EntityResult): Promise<void> {
  editProjectId.value = entity.id
  editProjectName.value = entity.name
  closeProjectDropdown()
  await saveField({ project_entity_id: entity.id })
}

async function clearProject(): Promise<void> {
  editProjectId.value = null
  editProjectName.value = null
  await saveField({ project_entity_id: null })
}

// ── Assignee entity search ────────────────────────────────────────────────────
async function onAssigneeSearchInput(): Promise<void> {
  if (assigneeSearch.value.length < 1) {
    assigneeResults.value = []
    return
  }
  const results = await window.api.invoke('entities:search', {
    query: assigneeSearch.value,
    type_id: 'person',
  }) as EntityResult[]
  assigneeResults.value = results
}

function openAssigneeDropdown(): void {
  assigneeSearch.value = ''
  assigneeResults.value = []
  assigneeDropdownOpen.value = true
  nextTick(() => document.getElementById('tdp-assignee-search')?.focus())
}

function closeAssigneeDropdown(): void {
  assigneeDropdownOpen.value = false
  assigneeSearch.value = ''
}

async function selectAssignee(entity: EntityResult): Promise<void> {
  editAssignedId.value = entity.id
  editAssignedName.value = entity.name
  closeAssigneeDropdown()
  await saveField({ assigned_entity_id: entity.id })
}

async function clearAssignee(): Promise<void> {
  editAssignedId.value = null
  editAssignedName.value = null
  await saveField({ assigned_entity_id: null })
}

// ── Waiting-for entity search ─────────────────────────────────────────────────
async function onWaitingSearchInput(): Promise<void> {
  if (waitingSearch.value.length < 1) {
    waitingResults.value = []
    return
  }
  const results = await window.api.invoke('entities:search', {
    query: waitingSearch.value,
    type_id: 'person',
  }) as EntityResult[]
  waitingResults.value = results
}

function openWaitingDropdown(): void {
  waitingSearch.value = ''
  waitingResults.value = []
  waitingDropdownOpen.value = true
  nextTick(() => document.getElementById('tdp-waiting-search')?.focus())
}

function closeWaitingDropdown(): void {
  waitingDropdownOpen.value = false
  waitingSearch.value = ''
}

async function selectWaitingFor(entity: EntityResult): Promise<void> {
  editWaitingForId.value = entity.id
  editWaitingForName.value = entity.name
  closeWaitingDropdown()
  await saveField({ waiting_for_entity_id: entity.id })
}

async function clearWaitingFor(): Promise<void> {
  editWaitingForId.value = null
  editWaitingForName.value = null
  await saveField({ waiting_for_entity_id: null })
}

// ── Sub-tasks ─────────────────────────────────────────────────────────────────
function openSubTaskInput(): void {
  showSubTaskInput.value = true
  nextTick(() => subTaskInputRef.value?.focus())
}

function onSubTaskCreated(newTask: ActionItem): void {
  subTasks.value = [...subTasks.value, newTask]
  showSubTaskInput.value = false
}

function onSubTaskStatusChanged(taskId: string, status: ActionItem['status']): void {
  const idx = subTasks.value.findIndex((t) => t.id === taskId)
  if (idx !== -1) {
    subTasks.value[idx] = { ...subTasks.value[idx], status }
  }
}

// ── Source note ───────────────────────────────────────────────────────────────
function openSourceNote(e: MouseEvent): void {
  if (!task.value?.source_note_id) return
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', {
    noteId: task.value.source_note_id,
    title: task.value.source_note_title ?? 'Untitled',
    mode,
  })
}

// ── Delete task ───────────────────────────────────────────────────────────────
async function deleteTask(): Promise<void> {
  if (!task.value) return
  await window.api.invoke('action-items:delete', { id: task.value.id })
  emit('deleted', task.value.id)
  emit('close')
}

// ── Computed ──────────────────────────────────────────────────────────────────
const statusOptions: { value: ActionItem['status']; label: string }[] = [
  { value: 'open',        label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done',        label: 'Done' },
  { value: 'someday',     label: 'Someday' },
  { value: 'cancelled',   label: 'Cancelled' },
]

const formattedCreatedAt = computed(() => {
  if (!task.value) return ''
  return new Date(task.value.created_at).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  })
})

const formattedUpdatedAt = computed(() => {
  if (!task.value?.updated_at) return ''
  const d = new Date(task.value.updated_at)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  return `${diffDays}d ago`
})
</script>

<template>
  <div class="task-detail-panel" role="complementary" :aria-label="task ? `Task: ${task.title}` : 'Task details'">
    <!-- Header -->
    <div class="panel-header">
      <input
        v-model="editTitle"
        class="title-input"
        placeholder="Task title"
        aria-label="Task title"
        @blur="onTitleBlur"
        @keydown="onTitleKeydown"
      />
      <div class="header-actions">
        <button
          class="btn-icon"
          title="Open in Actions view"
          aria-label="Open in Actions view"
          @click="emit('open-actions')"
        >
          <ExternalLink :size="14" />
        </button>
        <button class="btn-icon" title="Close (⌘W)" aria-label="Close panel" @click="emit('close')">
          <X :size="15" />
        </button>
      </div>
    </div>

    <div v-if="loading" class="panel-loading">Loading…</div>

    <div v-else-if="task" class="panel-body">

      <!-- ── Status ─────────────────────────────────────────────────────── -->
      <div class="field-row">
        <span class="field-label">Status</span>
        <select v-model="editStatus" class="field-select" aria-label="Task status" @change="onStatusChange">
          <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </div>

      <!-- ── Project ────────────────────────────────────────────────────── -->
      <div class="field-row">
        <span class="field-label">Project</span>
        <div class="field-value">
          <TaskAttributeChip
            v-if="editProjectName"
            type="project"
            :label="editProjectName"
            :removable="true"
            @remove="clearProject"
          />
          <div v-if="!editProjectName || projectDropdownOpen" class="entity-search-wrap">
            <button
              v-if="!projectDropdownOpen && !editProjectName"
              class="btn-add-field"
              @click="openProjectDropdown"
            >+ Set project</button>
            <div v-if="projectDropdownOpen" class="entity-dropdown">
              <input
                id="tdp-project-search"
                v-model="projectSearch"
                class="entity-search-input"
                placeholder="Search projects…"
                aria-label="Search projects"
                aria-autocomplete="list"
                @input="onProjectSearchInput"
                @keydown.escape="closeProjectDropdown"
              />
              <ul v-if="projectResults.length" class="entity-results">
                <li
                  v-for="r in projectResults"
                  :key="r.id"
                  class="entity-result"
                  @mousedown.prevent="selectProject(r)"
                >{{ r.name }}</li>
              </ul>
              <button class="btn-cancel-sm" @click="closeProjectDropdown">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Assignee ───────────────────────────────────────────────────── -->
      <div class="field-row">
        <span class="field-label">Assignee</span>
        <div class="field-value">
          <span v-if="editAssignedName && !assigneeDropdownOpen" class="assigned-chip">
            @{{ editAssignedName }}
            <button class="chip-remove" :aria-label="`Remove assignee ${editAssignedName}`" @click="clearAssignee">×</button>
          </span>
          <div v-if="!editAssignedName || assigneeDropdownOpen" class="entity-search-wrap">
            <button
              v-if="!assigneeDropdownOpen && !editAssignedName"
              class="btn-add-field"
              @click="openAssigneeDropdown"
            >+ Assign</button>
            <div v-if="assigneeDropdownOpen" class="entity-dropdown">
              <input
                id="tdp-assignee-search"
                v-model="assigneeSearch"
                class="entity-search-input"
                placeholder="Search people…"
                aria-label="Search assignee"
                aria-autocomplete="list"
                @input="onAssigneeSearchInput"
                @keydown.escape="closeAssigneeDropdown"
              />
              <ul v-if="assigneeResults.length" class="entity-results">
                <li
                  v-for="r in assigneeResults"
                  :key="r.id"
                  class="entity-result"
                  @mousedown.prevent="selectAssignee(r)"
                >{{ r.name }}</li>
              </ul>
              <button class="btn-cancel-sm" @click="closeAssigneeDropdown">Cancel</button>
            </div>
          </div>
        </div>
      </div>

      <!-- ── Due date ───────────────────────────────────────────────────── -->
      <div class="field-row">
        <span class="field-label">Due date</span>
        <div class="field-value">
          <input
            v-model="editDueDate"
            type="date"
            class="field-date"
            aria-label="Due date"
            @change="onDueDateChange"
          />
          <button v-if="editDueDate" class="btn-clear-field" title="Clear due date" aria-label="Clear due date" @click="editDueDate = ''; onDueDateChange()">×</button>
        </div>
      </div>

      <!-- ── Contexts ───────────────────────────────────────────────────── -->
      <div class="field-row field-row--wrap">
        <span class="field-label">Contexts</span>
        <div class="field-value field-value--wrap">
          <TaskAttributeChip
            v-for="ctx in editContexts"
            :key="ctx"
            type="context"
            :label="ctx"
            :removable="true"
            @remove="removeContext(ctx)"
          />
          <div class="context-input-wrap">
            <input
              v-model="editContextInput"
              class="context-input"
              placeholder="@context"
              aria-label="Add context tag"
              autocomplete="off"
              @input="onContextInput"
              @focus="onContextFocus"
              @keydown="onContextKeydown"
              @blur="() => void addContext()"
            />
            <ul
              v-if="contextDropdownOpen && contextSuggestions.length"
              class="context-suggestions"
            >
              <li
                v-for="s in contextSuggestions"
                :key="s"
                class="context-suggestion"
                @mousedown.prevent="addContext(s)"
              >{{ s }}</li>
            </ul>
          </div>
        </div>
      </div>

      <!-- ── Energy ─────────────────────────────────────────────────────── -->
      <div class="field-row">
        <span class="field-label">Energy</span>
        <div class="field-value energy-row">
          <button
            class="energy-btn"
            :class="{ 'energy-btn--active': editEnergyLevel === 'low' }"
            :aria-pressed="editEnergyLevel === 'low'"
            aria-label="Low energy"
            @click="onEnergyChange(editEnergyLevel === 'low' ? '' : 'low')"
          >
            <TaskAttributeChip type="energy" label="Low" energy-level="low" />
          </button>
          <button
            class="energy-btn"
            :class="{ 'energy-btn--active': editEnergyLevel === 'medium' }"
            :aria-pressed="editEnergyLevel === 'medium'"
            aria-label="Medium energy"
            @click="onEnergyChange(editEnergyLevel === 'medium' ? '' : 'medium')"
          >
            <TaskAttributeChip type="energy" label="Med" energy-level="medium" />
          </button>
          <button
            class="energy-btn"
            :class="{ 'energy-btn--active': editEnergyLevel === 'high' }"
            :aria-pressed="editEnergyLevel === 'high'"
            aria-label="High energy"
            @click="onEnergyChange(editEnergyLevel === 'high' ? '' : 'high')"
          >
            <TaskAttributeChip type="energy" label="High" energy-level="high" />
          </button>
        </div>
      </div>

      <!-- ── Waiting for ────────────────────────────────────────────────── -->
      <div class="field-row">
        <span class="field-label">Waiting for</span>
        <div class="field-value">
          <button
            class="waiting-toggle"
            :class="{ 'waiting-toggle--on': editIsWaitingFor }"
            :aria-pressed="editIsWaitingFor"
            aria-label="Toggle waiting for"
            @click="onWaitingToggle"
          >
            <Check v-if="editIsWaitingFor" :size="10" />
            {{ editIsWaitingFor ? 'Yes' : 'No' }}
          </button>
          <template v-if="editIsWaitingFor">
            <span v-if="editWaitingForName && !waitingDropdownOpen" class="assigned-chip">
              @{{ editWaitingForName }}
              <button class="chip-remove" :aria-label="`Remove waiting for ${editWaitingForName}`" @click="clearWaitingFor">×</button>
            </span>
            <div v-if="!editWaitingForName || waitingDropdownOpen" class="entity-search-wrap">
              <button
                v-if="!waitingDropdownOpen && !editWaitingForName"
                class="btn-add-field"
                @click="openWaitingDropdown"
              >+ Who?</button>
              <div v-if="waitingDropdownOpen" class="entity-dropdown">
                <input
                  id="tdp-waiting-search"
                  v-model="waitingSearch"
                  class="entity-search-input"
                  placeholder="Search people…"
                  aria-label="Search waiting for person"
                  aria-autocomplete="list"
                  @input="onWaitingSearchInput"
                  @keydown.escape="closeWaitingDropdown"
                />
                <ul v-if="waitingResults.length" class="entity-results">
                  <li
                    v-for="r in waitingResults"
                    :key="r.id"
                    class="entity-result"
                    @mousedown.prevent="selectWaitingFor(r)"
                  >{{ r.name }}</li>
                </ul>
                <button class="btn-cancel-sm" @click="closeWaitingDropdown">Cancel</button>
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- ── Divider ────────────────────────────────────────────────────── -->
      <div class="section-divider" />

      <!-- ── Sub-tasks ──────────────────────────────────────────────────── -->
      <div class="section-header">
        <span class="section-title">Sub-tasks</span>
        <button class="btn-add-sm" aria-label="Add sub-task" @click="openSubTaskInput">
          <Plus :size="11" /> Add
        </button>
      </div>

      <div class="subtasks-list">
        <TaskCard
          v-for="sub in subTasks"
          :key="sub.id"
          :task="sub"
          :depth="1"
          :show-project="false"
          :show-source-note="false"
          @open-detail="(id) => $emit('close') /* handled by parent */"
          @status-changed="onSubTaskStatusChanged"
          @open-note="emit('open-note', $event)"
          @subtask-created="onSubTaskCreated"
        />

        <SubTaskInput
          v-if="showSubTaskInput"
          ref="subTaskInputRef"
          :parent-id="task.id"
          :source-note-id="task.source_note_id"
          @created="onSubTaskCreated"
          @cancel="showSubTaskInput = false"
        />

        <p v-if="subTasks.length === 0 && !showSubTaskInput" class="empty-hint">
          No sub-tasks
        </p>
      </div>

      <!-- ── Source note ─────────────────────────────────────────────────── -->
      <div v-if="task.source_note_id" class="section-divider" />
      <div v-if="task.source_note_id" class="source-row">
        <span class="field-label">Source</span>
        <button class="source-note-btn" @click="openSourceNote($event)">
          <FileText :size="11" />
          {{ task.source_note_title ?? 'Untitled' }}
        </button>
      </div>

      <!-- ── Footer meta + delete ──────────────────────────────────────── -->
      <div class="panel-footer">
        <span class="footer-meta">
          <span>Created {{ formattedCreatedAt }}</span>
          <span v-if="formattedUpdatedAt">· Updated {{ formattedUpdatedAt }}</span>
        </span>
        <div class="footer-delete">
          <button
            v-if="!confirmDelete"
            class="btn-delete"
            aria-label="Delete task"
            @click="confirmDelete = true"
          >
            <Trash2 :size="13" />
            Delete
          </button>
          <template v-else>
            <span class="delete-confirm-label">Delete task?</span>
            <button class="btn-delete-confirm" @click="deleteTask">Yes, delete</button>
            <button class="btn-cancel-sm" @click="confirmDelete = false">Cancel</button>
          </template>
        </div>
      </div>
    </div>

    <div v-else-if="!loading" class="panel-loading">Task not found.</div>
  </div>
</template>

<style scoped>
.task-detail-panel {
  width: 380px;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border-left: 1px solid var(--color-border);
  overflow: hidden;
  flex-shrink: 0;
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.panel-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.title-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--color-text);
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  padding: 3px 6px;
  outline: none;
}

.title-input:hover {
  background: var(--color-hover);
}

.title-input:focus {
  background: var(--color-surface);
  box-shadow: 0 0 0 1px var(--color-border);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 5px;
  padding: 4px 6px;
}

.btn-icon:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

/* ── Body ─────────────────────────────────────────────────────────────────── */
.panel-loading {
  padding: 24px 16px;
  color: var(--color-text-muted);
  font-size: 13px;
  text-align: center;
}

.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0;
}

/* ── Field rows ───────────────────────────────────────────────────────────── */
.field-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 14px;
  min-height: 32px;
}

.field-row--wrap {
  align-items: flex-start;
}

.field-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  width: 72px;
  flex-shrink: 0;
  padding-top: 2px;
}

.field-value {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  min-width: 0;
}

.field-value--wrap {
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.field-select {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  padding: 4px 24px 4px 8px;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 7px center;
  transition: border-color 0.15s;
}

.field-select:focus {
  border-color: var(--color-accent);
}

.field-date {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  padding: 4px 6px;
  outline: none;
  transition: border-color 0.15s;
}

.field-date:focus {
  border-color: var(--color-accent);
}

.btn-clear-field {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;
}

.btn-clear-field:hover {
  color: var(--color-text);
}

/* ── Entity search ────────────────────────────────────────────────────────── */
.entity-search-wrap {
  position: relative;
}

.entity-dropdown {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.entity-search-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  padding: 4px 8px;
  width: 160px;
  outline: none;
  transition: border-color 0.15s;
}

.entity-search-input::placeholder {
  color: var(--color-text-muted);
}

.entity-search-input:focus {
  border-color: var(--color-accent);
}

.entity-results {
  list-style: none;
  margin: 0;
  padding: 2px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  max-height: 140px;
  overflow-y: auto;
}

.entity-result {
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--color-text);
}

.entity-result:hover {
  background: var(--color-hover);
}

.btn-add-field {
  background: transparent;
  border: 1px dashed var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 8px;
  cursor: pointer;
}

.btn-add-field:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.btn-cancel-sm {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 0 2px;
  text-align: left;
}

.btn-cancel-sm:hover {
  color: var(--color-text);
}

/* ── Assigned / waiting chip ──────────────────────────────────────────────── */
.assigned-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: rgba(91,141,239,0.12);
  color: #5b8def;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  font-weight: 500;
}

.chip-remove {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 0 0 2px;
  opacity: 0.7;
}

.chip-remove:hover {
  opacity: 1;
}

/* ── Contexts ─────────────────────────────────────────────────────────────── */
.context-input-wrap {
  position: relative;
}

.context-input {
  background: transparent;
  border: none;
  border-bottom: 1px dashed var(--color-border);
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  padding: 1px 4px;
  outline: none;
  width: 80px;
}

.context-input:focus {
  border-bottom-color: var(--color-accent);
}

.context-suggestions {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  min-width: 120px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.2);
  list-style: none;
  margin: 0;
  padding: 3px;
  z-index: 100;
}

.context-suggestion {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--color-text);
  cursor: pointer;
}

.context-suggestion:hover {
  background: var(--color-hover);
}

/* ── Energy ───────────────────────────────────────────────────────────────── */
.energy-row {
  gap: 4px;
}

.energy-btn {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  opacity: 0.4;
  transition: opacity 0.1s;
  border-radius: 4px;
}

.energy-btn:hover,
.energy-btn--active {
  opacity: 1;
}

/* ── Waiting toggle ───────────────────────────────────────────────────────── */
.waiting-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  padding: 2px 8px;
  cursor: pointer;
}

.waiting-toggle--on {
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(139, 92, 246, 0.6);
  color: #8b5cf6;
}

/* ── Divider ──────────────────────────────────────────────────────────────── */
.section-divider {
  height: 1px;
  background: var(--color-border);
  margin: 10px 14px;
}

/* ── Section header ───────────────────────────────────────────────────────── */
.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 14px 6px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-muted);
  opacity: 0.7;
}

.btn-add-sm {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 7px;
  cursor: pointer;
}

.btn-add-sm:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

/* ── Sub-tasks list ───────────────────────────────────────────────────────── */
.subtasks-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0 14px;
}

.empty-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  opacity: 0.5;
  margin: 0;
  padding: 2px 0;
}

/* ── Source row ───────────────────────────────────────────────────────────── */
.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 14px;
}

.source-note-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 240px;
}

.source-note-btn:hover {
  color: var(--color-accent);
  background: var(--color-hover);
}

/* ── Footer ───────────────────────────────────────────────────────────────── */
.panel-footer {
  padding: 10px 14px 14px;
  font-size: 11px;
  color: var(--color-text-muted);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.footer-meta {
  opacity: 0.55;
  display: flex;
  gap: 4px;
}

.footer-delete {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-delete {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0.5;
}

.btn-delete:hover {
  opacity: 1;
  color: var(--color-danger);
}

.delete-confirm-label {
  font-size: 11px;
  color: var(--color-text-muted);
}

.btn-delete-confirm {
  background: var(--color-danger);
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 11px;
  font-family: inherit;
  padding: 2px 8px;
  cursor: pointer;
}

.btn-delete-confirm:hover {
  background: #c53030;
}
</style>
