<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { ExternalLink, X, Check } from 'lucide-vue-next'
import TaskAttributeChip from './TaskAttributeChip.vue'
import type { ActionItem } from './TaskCard.vue'
import { fireOpenDetail } from '../stores/taskDetailStore'
import { fireUnlink } from '../stores/taskInlineDetailStore'
import type { OpenMode } from '../stores/tabStore'

const props = defineProps<{
  actionId: string
  anchorRect: DOMRect
}>()

const emit = defineEmits<{
  close: []
  'open-note': [payload: { noteId: string; title: string; mode: OpenMode }]
}>()

// ── Positioning ───────────────────────────────────────────────────────────────
const POPUP_WIDTH = 340
const POPUP_APPROX_HEIGHT = 360

const popupTop = computed(() => {
  const spaceBelow = window.innerHeight - props.anchorRect.bottom
  if (spaceBelow < POPUP_APPROX_HEIGHT + 16) {
    return Math.max(8, props.anchorRect.top - POPUP_APPROX_HEIGHT - 8)
  }
  return props.anchorRect.bottom + 8
})

const popupLeft = computed(() =>
  Math.min(props.anchorRect.left, window.innerWidth - POPUP_WIDTH - 8),
)

// ── Task state ────────────────────────────────────────────────────────────────
const task = ref<ActionItem | null>(null)
const loading = ref(true)
const saving = ref(false)

// Edit state
const editStatus = ref<ActionItem['status']>('open')
const editDueDate = ref('')
const editEnergyLevel = ref<'low' | 'medium' | 'high' | ''>('')
const editIsWaitingFor = ref(false)
const editContexts = ref<string[]>([])
const editContextInput = ref('')

// Entity state
const editProjectId = ref<string | null>(null)
const editProjectName = ref<string | null>(null)
const editAssignedId = ref<string | null>(null)
const editAssignedName = ref<string | null>(null)
const editWaitingForId = ref<string | null>(null)
const editWaitingForName = ref<string | null>(null)

const projectEntityTypeId = ref('')

// Entity search
type EntityResult = { id: string; name: string }
const projectSearch = ref('')
const projectResults = ref<EntityResult[]>([])
const projectDropdownOpen = ref(false)
const assigneeSearch = ref('')
const assigneeResults = ref<EntityResult[]>([])
const assigneeDropdownOpen = ref(false)

// ── Load ──────────────────────────────────────────────────────────────────────
async function load(): Promise<void> {
  loading.value = true
  try {
    const [result, typeId] = await Promise.all([
      window.api.invoke('action-items:get', { id: props.actionId }) as Promise<ActionItem | null>,
      window.api.invoke('settings:get', { key: 'gtd_project_entity_type_id' }) as Promise<string | null>,
    ])
    if (!result) return
    task.value = result
    projectEntityTypeId.value = typeId ?? ''

    editStatus.value = result.status
    editDueDate.value = result.due_date ?? ''
    editEnergyLevel.value = result.energy_level ?? ''
    editIsWaitingFor.value = result.is_waiting_for === 1
    editProjectId.value = result.project_entity_id
    editProjectName.value = result.project_name
    editAssignedId.value = result.assigned_entity_id
    editAssignedName.value = result.assigned_entity_name
    editWaitingForId.value = result.waiting_for_entity_id
    editWaitingForName.value = result.waiting_for_entity_name
    try { editContexts.value = JSON.parse(result.contexts) as string[] }
    catch { editContexts.value = [] }
  } finally {
    loading.value = false
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────
async function save(fields: Record<string, unknown>): Promise<void> {
  if (!task.value) return
  saving.value = true
  try {
    await window.api.invoke('action-items:update', { id: task.value.id, ...fields })
  } finally {
    saving.value = false
  }
}

async function onStatusChange(): Promise<void> { await save({ status: editStatus.value }) }
async function onDueDateChange(): Promise<void> { await save({ due_date: editDueDate.value || null }) }
async function onEnergyChange(e: 'low' | 'medium' | 'high' | ''): Promise<void> {
  editEnergyLevel.value = e; await save({ energy_level: e || null })
}
async function onWaitingToggle(): Promise<void> {
  editIsWaitingFor.value = !editIsWaitingFor.value
  if (!editIsWaitingFor.value) {
    editWaitingForId.value = null; editWaitingForName.value = null
    await save({ is_waiting_for: 0, waiting_for_entity_id: null })
  } else {
    await save({ is_waiting_for: 1 })
  }
}

async function addContext(): Promise<void> {
  const ctx = editContextInput.value.trim()
  if (!ctx || editContexts.value.includes(ctx)) { editContextInput.value = ''; return }
  editContexts.value = [...editContexts.value, ctx]
  await save({ contexts: JSON.stringify(editContexts.value) })
  editContextInput.value = ''
}

async function removeContext(ctx: string): Promise<void> {
  editContexts.value = editContexts.value.filter((c) => c !== ctx)
  await save({ contexts: JSON.stringify(editContexts.value) })
}

// ── Entity search: project ────────────────────────────────────────────────────
async function onProjectInput(): Promise<void> {
  if (!projectSearch.value) { projectResults.value = []; return }
  projectResults.value = (await window.api.invoke('entities:search', {
    query: projectSearch.value,
    type_id: projectEntityTypeId.value || undefined,
  })) as EntityResult[]
}

function openProjectSearch(): void {
  projectSearch.value = ''; projectResults.value = []; projectDropdownOpen.value = true
  nextTick(() => document.getElementById('tid-proj')?.focus())
}

async function pickProject(e: EntityResult): Promise<void> {
  editProjectId.value = e.id; editProjectName.value = e.name
  projectDropdownOpen.value = false; projectSearch.value = ''
  await save({ project_entity_id: e.id })
}

async function clearProject(): Promise<void> {
  editProjectId.value = null; editProjectName.value = null
  await save({ project_entity_id: null })
}

// ── Entity search: assignee ───────────────────────────────────────────────────
async function onAssigneeInput(): Promise<void> {
  if (!assigneeSearch.value) { assigneeResults.value = []; return }
  assigneeResults.value = (await window.api.invoke('entities:search', {
    query: assigneeSearch.value, type_id: 'person',
  })) as EntityResult[]
}

function openAssigneeSearch(): void {
  assigneeSearch.value = ''; assigneeResults.value = []; assigneeDropdownOpen.value = true
  nextTick(() => document.getElementById('tid-ass')?.focus())
}

async function pickAssignee(e: EntityResult): Promise<void> {
  editAssignedId.value = e.id; editAssignedName.value = e.name
  assigneeDropdownOpen.value = false; assigneeSearch.value = ''
  await save({ assigned_entity_id: e.id })
}

async function clearAssignee(): Promise<void> {
  editAssignedId.value = null; editAssignedName.value = null
  await save({ assigned_entity_id: null })
}

// ── Actions ───────────────────────────────────────────────────────────────────
function openInActions(): void {
  fireOpenDetail(props.actionId)
  emit('close')
}

function unlinkTask(): void {
  fireUnlink(props.actionId)
  emit('close')
}

// ── Click-outside + Escape ────────────────────────────────────────────────────
const popupRef = ref<HTMLElement | null>(null)

function onDocMouseDown(e: MouseEvent): void {
  if (popupRef.value && !popupRef.value.contains(e.target as Node)) emit('close')
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  load()
  document.addEventListener('mousedown', onDocMouseDown)
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="popupRef"
      class="task-inline-detail"
      :style="{ top: popupTop + 'px', left: popupLeft + 'px', width: POPUP_WIDTH + 'px' }"
      @mousedown.stop
    >
      <!-- Header -->
      <div class="popup-header">
        <span class="popup-title">{{ task?.title ?? '…' }}</span>
        <div class="popup-header-btns">
          <button class="btn-open-actions" title="Open in Actions" @click="openInActions">
            <ExternalLink :size="12" /> Open
          </button>
          <button class="btn-icon-sm" @click="emit('close')"><X :size="13" /></button>
        </div>
      </div>

      <div v-if="loading" class="popup-loading">Loading…</div>

      <div v-else-if="task" class="popup-body">

        <!-- Status + Due date row -->
        <div class="row-pair">
          <div class="field-inline">
            <span class="label-sm">Status</span>
            <select v-model="editStatus" class="select-sm" @change="onStatusChange">
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="done">Done</option>
              <option value="someday">Someday</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div class="field-inline">
            <span class="label-sm">Due</span>
            <input v-model="editDueDate" type="date" class="input-sm" @change="onDueDateChange" />
            <button v-if="editDueDate" class="btn-clear-sm" @click="editDueDate = ''; onDueDateChange()">×</button>
          </div>
        </div>

        <!-- Project -->
        <div class="field-row">
          <span class="label-sm">Project</span>
          <div class="field-value-row">
            <TaskAttributeChip v-if="editProjectName" type="project" :label="editProjectName" :removable="true" @remove="clearProject" />
            <template v-if="!editProjectName || projectDropdownOpen">
              <button v-if="!projectDropdownOpen && !editProjectName" class="btn-add-sm" @click="openProjectSearch">+ Set</button>
              <div v-if="projectDropdownOpen" class="entity-mini-search">
                <input id="tid-proj" v-model="projectSearch" class="mini-search-input" placeholder="Search…" @input="onProjectInput" @keydown.escape="projectDropdownOpen = false" />
                <ul v-if="projectResults.length" class="mini-results">
                  <li v-for="r in projectResults" :key="r.id" @mousedown.prevent="pickProject(r)">{{ r.name }}</li>
                </ul>
              </div>
            </template>
          </div>
        </div>

        <!-- Assignee -->
        <div class="field-row">
          <span class="label-sm">Assignee</span>
          <div class="field-value-row">
            <span v-if="editAssignedName && !assigneeDropdownOpen" class="assignee-chip">
              @{{ editAssignedName }}<button class="chip-x" @click="clearAssignee">×</button>
            </span>
            <template v-if="!editAssignedName || assigneeDropdownOpen">
              <button v-if="!assigneeDropdownOpen && !editAssignedName" class="btn-add-sm" @click="openAssigneeSearch">+ Assign</button>
              <div v-if="assigneeDropdownOpen" class="entity-mini-search">
                <input id="tid-ass" v-model="assigneeSearch" class="mini-search-input" placeholder="Search people…" @input="onAssigneeInput" @keydown.escape="assigneeDropdownOpen = false" />
                <ul v-if="assigneeResults.length" class="mini-results">
                  <li v-for="r in assigneeResults" :key="r.id" @mousedown.prevent="pickAssignee(r)">{{ r.name }}</li>
                </ul>
              </div>
            </template>
          </div>
        </div>

        <!-- Contexts -->
        <div class="field-row">
          <span class="label-sm">Contexts</span>
          <div class="field-value-row contexts-row">
            <TaskAttributeChip v-for="ctx in editContexts" :key="ctx" type="context" :label="ctx" :removable="true" @remove="removeContext(ctx)" />
            <input v-model="editContextInput" class="ctx-input" placeholder="@tag" @keydown.enter.prevent="addContext" @blur="addContext" />
          </div>
        </div>

        <!-- Energy + Waiting row -->
        <div class="row-pair">
          <div class="field-inline">
            <span class="label-sm">Energy</span>
            <div class="energy-row">
              <button v-for="e in ['low','medium','high'] as const" :key="e" class="energy-btn" :class="{ 'energy-btn--on': editEnergyLevel === e }" @click="onEnergyChange(editEnergyLevel === e ? '' : e)">
                <TaskAttributeChip type="energy" :label="e[0].toUpperCase()" :energy-level="e" />
              </button>
            </div>
          </div>
          <div class="field-inline">
            <span class="label-sm">Waiting</span>
            <button class="waiting-btn" :class="{ 'waiting-btn--on': editIsWaitingFor }" @click="onWaitingToggle">
              <Check v-if="editIsWaitingFor" :size="9" /> {{ editIsWaitingFor ? 'Yes' : 'No' }}
            </button>
          </div>
        </div>

        <!-- Source note -->
        <div v-if="task.source_note_id" class="source-row">
          <span class="label-sm">Source</span>
          <button class="source-btn" @click="emit('open-note', { noteId: task.source_note_id!, title: task.source_note_title ?? 'Untitled', mode: 'default' })">
            {{ task.source_note_title ?? 'Untitled' }}
          </button>
        </div>

        <!-- Footer: unlink -->
        <div class="popup-footer">
          <button class="btn-unlink" @click="unlinkTask">Unlink from note</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.task-inline-detail {
  position: fixed;
  z-index: 1050;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,0.35);
  overflow: hidden;
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--color-border);
}

.popup-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popup-header-btns {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.btn-open-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  background: rgba(91,141,239,0.1);
  border: 1px solid rgba(91,141,239,0.25);
  border-radius: 5px;
  color: var(--color-accent);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.btn-open-actions:hover { background: rgba(91,141,239,0.18); }

.btn-icon-sm {
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
}

.btn-icon-sm:hover { background: var(--color-hover); }

/* ── Body ─────────────────────────────────────────────────────────────────── */
.popup-loading {
  padding: 16px;
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
}

.popup-body {
  padding: 8px 0 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* ── Row pair (side-by-side fields) ──────────────────────────────────────── */
.row-pair {
  display: flex;
  gap: 8px;
  padding: 3px 12px;
}

.field-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
}

/* ── Field row ────────────────────────────────────────────────────────────── */
.field-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 3px 12px;
  min-height: 26px;
}

.label-sm {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  width: 52px;
  flex-shrink: 0;
  padding-top: 3px;
}

.field-value-row {
  flex: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}

/* ── Inputs ───────────────────────────────────────────────────────────────── */
.select-sm {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 6px;
  outline: none;
  cursor: pointer;
}

.input-sm {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 5px;
  outline: none;
}

.btn-clear-sm {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 13px;
  padding: 0;
  line-height: 1;
}

/* ── Entity mini search ───────────────────────────────────────────────────── */
.entity-mini-search {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mini-search-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text);
  font-size: 11px;
  font-family: inherit;
  padding: 3px 6px;
  outline: none;
  width: 130px;
}

.mini-search-input:focus { border-color: var(--color-accent); }

.mini-results {
  list-style: none;
  margin: 0;
  padding: 2px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  max-height: 100px;
  overflow-y: auto;
}

.mini-results li {
  padding: 4px 7px;
  font-size: 12px;
  cursor: pointer;
  border-radius: 3px;
  color: var(--color-text);
}

.mini-results li:hover { background: var(--color-hover); }

.btn-add-sm {
  background: transparent;
  border: 1px dashed var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 10px;
  font-family: inherit;
  padding: 1px 6px;
  cursor: pointer;
}

.btn-add-sm:hover { border-color: var(--color-accent); color: var(--color-accent); }

/* ── Assignee chip ────────────────────────────────────────────────────────── */
.assignee-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: rgba(91,141,239,0.12);
  color: #5b8def;
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-weight: 500;
}

.chip-x {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  padding: 0 0 0 2px;
  opacity: 0.7;
}

.chip-x:hover { opacity: 1; }

/* ── Contexts ─────────────────────────────────────────────────────────────── */
.contexts-row { flex-wrap: wrap; }

.ctx-input {
  background: transparent;
  border: none;
  border-bottom: 1px dashed var(--color-border);
  color: var(--color-text);
  font-size: 11px;
  font-family: inherit;
  padding: 1px 3px;
  outline: none;
  width: 60px;
}

.ctx-input:focus { border-bottom-color: var(--color-accent); }

/* ── Energy ───────────────────────────────────────────────────────────────── */
.energy-row { display: flex; gap: 2px; }

.energy-btn {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  opacity: 0.35;
  border-radius: 3px;
}

.energy-btn:hover, .energy-btn--on { opacity: 1; }

/* ── Waiting ──────────────────────────────────────────────────────────────── */
.waiting-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 6px;
  cursor: pointer;
}

.waiting-btn--on {
  background: rgba(139,92,246,0.1);
  border-color: #8b5cf6;
  color: #8b5cf6;
}

/* ── Source note ──────────────────────────────────────────────────────────── */
.source-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
}

.source-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 1px 3px;
  border-radius: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 220px;
}

.source-btn:hover { color: var(--color-accent); }

/* ── Footer ───────────────────────────────────────────────────────────────── */
.popup-footer {
  border-top: 1px solid var(--color-border);
  padding: 7px 12px;
  margin-top: 4px;
}

.btn-unlink {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
  opacity: 0.6;
}

.btn-unlink:hover { opacity: 1; color: #ef4444; }
</style>
