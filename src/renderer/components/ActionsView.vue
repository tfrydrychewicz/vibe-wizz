<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { CheckSquare, Plus, Trash2, FileText, Sparkles, ArrowRight, ArrowLeft, X, UserPlus } from 'lucide-vue-next'
import type { OpenMode } from '../stores/tabStore'

const emit = defineEmits<{
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

interface ActionItem {
  id: string
  title: string
  status: 'open' | 'in_progress' | 'done' | 'cancelled'
  extraction_type: 'manual' | 'ai_extracted'
  confidence: number
  created_at: string
  completed_at: string | null
  source_note_id: string | null
  assigned_entity_id: string | null
  due_date: string | null
  source_note_title: string | null
  assigned_entity_name: string | null
}

interface EntityResult {
  id: string
  name: string
  type_id: string
}

const items = ref<ActionItem[]>([])
const loading = ref(true)
const newItemTitle = ref('')
const showNewForm = ref(false)
const newFormInputRef = ref<HTMLInputElement | null>(null)
const confirmDeleteId = ref<string | null>(null)

// Assignee picker state
const assigneeEditId = ref<string | null>(null)
const assigneeQuery = ref('')
const assigneeResults = ref<EntityResult[]>([])
const assigneePopupPos = ref({ top: 0, left: 0 })
const assigneeInputRef = ref<HTMLInputElement | null>(null)
let assigneeSearchTimer: ReturnType<typeof setTimeout> | null = null

const open = computed(() => items.value.filter((i) => i.status === 'open'))
const inProgress = computed(() => items.value.filter((i) => i.status === 'in_progress'))
const done = computed(() => items.value.filter((i) => i.status === 'done'))

async function loadItems(): Promise<void> {
  loading.value = true
  try {
    items.value = (await window.api.invoke('action-items:list')) as ActionItem[]
  } finally {
    loading.value = false
  }
}

async function createItem(): Promise<void> {
  const t = newItemTitle.value.trim()
  if (!t) return
  await window.api.invoke('action-items:create', { title: t })
  newItemTitle.value = ''
  showNewForm.value = false
  await loadItems()
}

async function updateStatus(id: string, status: ActionItem['status']): Promise<void> {
  await window.api.invoke('action-items:update', { id, status })
  const item = items.value.find((i) => i.id === id)
  if (item) item.status = status
}

async function deleteItem(id: string): Promise<void> {
  await window.api.invoke('action-items:delete', { id })
  items.value = items.value.filter((i) => i.id !== id)
  confirmDeleteId.value = null
}

function openNote(e: MouseEvent, noteId: string, noteTitle: string): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId, title: noteTitle, mode })
}

function openNewForm(): void {
  showNewForm.value = true
  // focus input on next tick
  setTimeout(() => newFormInputRef.value?.focus(), 0)
}

function cancelNewForm(): void {
  showNewForm.value = false
  newItemTitle.value = ''
}

function onNewFormKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') createItem()
  else if (e.key === 'Escape') cancelNewForm()
}

function openAssigneePicker(id: string, event: MouseEvent): void {
  const btn = event.currentTarget as HTMLElement
  const rect = btn.getBoundingClientRect()
  const popupWidth = 224
  const left = Math.min(rect.left, window.innerWidth - popupWidth - 8)
  assigneePopupPos.value = { top: rect.bottom + 4, left }
  assigneeEditId.value = id
  assigneeQuery.value = ''
  assigneeResults.value = []
  nextTick(() => assigneeInputRef.value?.focus())
}

async function pickAssigneeById(entity: EntityResult): Promise<void> {
  const item = items.value.find((i) => i.id === assigneeEditId.value)
  if (!item) return
  await pickAssignee(item, entity)
}

function onDocMouseDown(): void {
  if (assigneeEditId.value !== null) closeAssigneePicker()
}

function closeAssigneePicker(): void {
  assigneeEditId.value = null
  assigneeQuery.value = ''
  assigneeResults.value = []
  if (assigneeSearchTimer) { clearTimeout(assigneeSearchTimer); assigneeSearchTimer = null }
}

function onAssigneeInput(): void {
  if (assigneeSearchTimer) clearTimeout(assigneeSearchTimer)
  assigneeSearchTimer = setTimeout(async () => {
    if (!assigneeQuery.value.trim()) { assigneeResults.value = []; return }
    assigneeResults.value = (await window.api.invoke('entities:search', { query: assigneeQuery.value })) as EntityResult[]
  }, 200)
}

async function pickAssignee(item: ActionItem, entity: EntityResult): Promise<void> {
  await window.api.invoke('action-items:update', { id: item.id, assigned_entity_id: entity.id })
  item.assigned_entity_id = entity.id
  item.assigned_entity_name = entity.name
  closeAssigneePicker()
}

async function clearAssignee(item: ActionItem): Promise<void> {
  await window.api.invoke('action-items:update', { id: item.id, assigned_entity_id: null })
  item.assigned_entity_id = null
  item.assigned_entity_name = null
}

// Refresh when an action item is created (e.g. promoted from a note task) or its status changes
const unsubscribeActionCreated = window.api.on('action:created', () => { void loadItems() })
const unsubscribeActionStatus = window.api.on('action:status-changed', () => { void loadItems() })

onMounted(() => {
  loadItems()
  document.addEventListener('mousedown', onDocMouseDown)
})
onBeforeUnmount(() => {
  unsubscribeActionCreated()
  unsubscribeActionStatus()
  document.removeEventListener('mousedown', onDocMouseDown)
})
</script>

<template>
  <div class="actions-view">
    <div class="actions-header">
      <div class="actions-title">
        <CheckSquare :size="16" />
        <h2>Actions</h2>
      </div>
      <button class="btn-new" @click="openNewForm">
        <Plus :size="13" />
        New action
      </button>
    </div>

    <!-- New action inline form -->
    <div v-if="showNewForm" class="new-form">
      <input
        ref="newFormInputRef"
        v-model="newItemTitle"
        class="new-form-input"
        placeholder="Action title…"
        @keydown="onNewFormKeydown"
      />
      <button class="btn-submit" :disabled="!newItemTitle.trim()" @click="createItem">Add</button>
      <button class="btn-cancel" @click="cancelNewForm"><X :size="13" /></button>
    </div>

    <div v-if="loading" class="loading">Loading…</div>

    <div v-else class="kanban">
      <!-- Open column -->
      <div class="column">
        <div class="column-header">
          <span class="column-dot dot-open" />
          Open
          <span class="column-count">{{ open.length }}</span>
        </div>
        <div class="column-body">
          <div v-for="item in open" :key="item.id" class="card">
            <div class="card-title">
              <span v-if="item.extraction_type === 'ai_extracted'" class="ai-badge" title="AI extracted">
                <Sparkles :size="10" />
              </span>
              {{ item.title }}
            </div>
            <div v-if="item.source_note_id" class="card-source">
              <FileText :size="11" />
              <button
                class="source-link"
                @click="openNote($event, item.source_note_id!, item.source_note_title || 'Untitled')"
              >
                {{ item.source_note_title || 'Untitled' }}
              </button>
            </div>
            <!-- Assignee chip -->
            <div v-if="item.assigned_entity_name" class="card-assignee">
              <span class="assignee-chip">
                @{{ item.assigned_entity_name }}
                <button class="assignee-clear" title="Unassign" @click.stop="clearAssignee(item)"><X :size="9" /></button>
              </span>
            </div>
            <div class="card-actions">
              <button class="card-btn" title="Assign" @click="openAssigneePicker(item.id, $event)">
                <UserPlus :size="12" />
              </button>
              <button class="card-btn" title="Move to In Progress" @click="updateStatus(item.id, 'in_progress')">
                <ArrowRight :size="12" />
              </button>
              <button
                v-if="confirmDeleteId === item.id"
                class="card-btn card-btn-danger"
                title="Confirm delete"
                @click="deleteItem(item.id)"
              >
                <Trash2 :size="12" /> confirm
              </button>
              <button
                v-else
                class="card-btn"
                title="Delete"
                @click="confirmDeleteId = item.id"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
          <div v-if="!open.length" class="column-empty">No open actions</div>
        </div>
      </div>

      <!-- In Progress column -->
      <div class="column">
        <div class="column-header">
          <span class="column-dot dot-progress" />
          In Progress
          <span class="column-count">{{ inProgress.length }}</span>
        </div>
        <div class="column-body">
          <div v-for="item in inProgress" :key="item.id" class="card">
            <div class="card-title">
              <span v-if="item.extraction_type === 'ai_extracted'" class="ai-badge" title="AI extracted">
                <Sparkles :size="10" />
              </span>
              {{ item.title }}
            </div>
            <div v-if="item.source_note_id" class="card-source">
              <FileText :size="11" />
              <button
                class="source-link"
                @click="openNote($event, item.source_note_id!, item.source_note_title || 'Untitled')"
              >
                {{ item.source_note_title || 'Untitled' }}
              </button>
            </div>
            <!-- Assignee chip -->
            <div v-if="item.assigned_entity_name" class="card-assignee">
              <span class="assignee-chip">
                @{{ item.assigned_entity_name }}
                <button class="assignee-clear" title="Unassign" @click.stop="clearAssignee(item)"><X :size="9" /></button>
              </span>
            </div>
            <div class="card-actions">
              <button class="card-btn" title="Assign" @click="openAssigneePicker(item.id, $event)">
                <UserPlus :size="12" />
              </button>
              <button class="card-btn" title="Move back to Open" @click="updateStatus(item.id, 'open')">
                <ArrowLeft :size="12" />
              </button>
              <button class="card-btn" title="Mark Done" @click="updateStatus(item.id, 'done')">
                <ArrowRight :size="12" />
              </button>
              <button
                v-if="confirmDeleteId === item.id"
                class="card-btn card-btn-danger"
                title="Confirm delete"
                @click="deleteItem(item.id)"
              >
                <Trash2 :size="12" /> confirm
              </button>
              <button
                v-else
                class="card-btn"
                title="Delete"
                @click="confirmDeleteId = item.id"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
          <div v-if="!inProgress.length" class="column-empty">Nothing in progress</div>
        </div>
      </div>

      <!-- Done column -->
      <div class="column">
        <div class="column-header">
          <span class="column-dot dot-done" />
          Done
          <span class="column-count">{{ done.length }}</span>
        </div>
        <div class="column-body">
          <div v-for="item in done" :key="item.id" class="card card-done">
            <div class="card-title">
              <span v-if="item.extraction_type === 'ai_extracted'" class="ai-badge" title="AI extracted">
                <Sparkles :size="10" />
              </span>
              {{ item.title }}
            </div>
            <div v-if="item.source_note_id" class="card-source">
              <FileText :size="11" />
              <button
                class="source-link"
                @click="openNote($event, item.source_note_id!, item.source_note_title || 'Untitled')"
              >
                {{ item.source_note_title || 'Untitled' }}
              </button>
            </div>
            <!-- Assignee chip -->
            <div v-if="item.assigned_entity_name" class="card-assignee">
              <span class="assignee-chip">
                @{{ item.assigned_entity_name }}
                <button class="assignee-clear" title="Unassign" @click.stop="clearAssignee(item)"><X :size="9" /></button>
              </span>
            </div>
            <div class="card-actions">
              <button class="card-btn" title="Assign" @click="openAssigneePicker(item.id, $event)">
                <UserPlus :size="12" />
              </button>
              <button class="card-btn" title="Reopen" @click="updateStatus(item.id, 'open')">
                <ArrowLeft :size="12" />
              </button>
              <button
                v-if="confirmDeleteId === item.id"
                class="card-btn card-btn-danger"
                title="Confirm delete"
                @click="deleteItem(item.id)"
              >
                <Trash2 :size="12" /> confirm
              </button>
              <button
                v-else
                class="card-btn"
                title="Delete"
                @click="confirmDeleteId = item.id"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
          <div v-if="!done.length" class="column-empty">Nothing done yet</div>
        </div>
      </div>
    </div>

    <!-- Assignee search popup — teleported to body so it floats over cards/columns -->
    <Teleport to="body">
      <div
        v-if="assigneeEditId !== null"
        class="assignee-popup"
        :style="{ top: assigneePopupPos.top + 'px', left: assigneePopupPos.left + 'px' }"
        @mousedown.stop
      >
        <input
          ref="assigneeInputRef"
          class="assignee-input"
          v-model="assigneeQuery"
          placeholder="Search entities…"
          autocomplete="off"
          @input="onAssigneeInput"
          @keydown.esc="closeAssigneePicker"
        />
        <div v-if="assigneeResults.length" class="assignee-dropdown">
          <button
            v-for="e in assigneeResults"
            :key="e.id"
            class="assignee-option"
            @mousedown.prevent="pickAssigneeById(e)"
          >{{ e.name }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.actions-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  padding: 24px 32px;
  gap: 16px;
}

.actions-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

.btn-new {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  font-weight: 500;
}

.btn-new:hover {
  opacity: 0.9;
}

.new-form {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
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

.new-form-input::placeholder {
  color: var(--color-text-muted);
}

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

.btn-submit:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-cancel {
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.btn-cancel:hover {
  color: var(--color-text);
}

.loading {
  font-size: 13px;
  color: var(--color-text-muted);
  text-align: center;
  padding: 32px;
}

.kanban {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  flex: 1;
  overflow: hidden;
  min-height: 0;
}

.column {
  display: flex;
  flex-direction: column;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
  min-height: 0;
}

.column-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.column-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-open     { background: #6b7280; }
.dot-progress { background: #f59e0b; }
.dot-done     { background: #22c55e; }

.column-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.7;
}

.column-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.column-empty {
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
  padding: 24px 8px;
  opacity: 0.5;
}

.card {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-done .card-title {
  text-decoration: line-through;
  opacity: 0.5;
}

.card-title {
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.4;
  display: flex;
  align-items: flex-start;
  gap: 5px;
}

.ai-badge {
  display: inline-flex;
  align-items: center;
  color: var(--color-accent);
  flex-shrink: 0;
  margin-top: 1px;
  opacity: 0.7;
}

.card-source {
  display: flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-muted);
}

.source-link {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 0;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 180px;
}

.source-link:hover {
  color: var(--color-accent);
  text-decoration: underline;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.1s;
}

.card:hover .card-actions {
  opacity: 1;
}

.card-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
}

.card-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.card-btn-danger {
  border-color: #ef4444;
  color: #ef4444;
}

.card-btn-danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

/* ── Assignee ─────────────────────────────────────────────────────────────── */
.card-assignee {
  display: flex;
  align-items: center;
  gap: 4px;
}

.assignee-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: rgba(91, 141, 239, 0.12);
  color: #5b8def;
  border-radius: 4px;
  padding: 1px 6px;
  font-size: 11px;
  font-weight: 500;
}

.assignee-clear {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: none;
  color: #5b8def;
  cursor: pointer;
  padding: 0;
  opacity: 0.6;
}

.assignee-clear:hover {
  opacity: 1;
}

.assignee-popup {
  position: fixed;
  z-index: 1000;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
  overflow: hidden;
  width: 224px;
  display: flex;
  flex-direction: column;
}

.assignee-input {
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 8px 12px;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.assignee-input:focus {
  border-bottom-color: var(--color-accent);
}

.assignee-dropdown {
  overflow: hidden;
}

.assignee-option {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 8px 12px;
  cursor: pointer;
}

.assignee-option:last-child {
  border-bottom: none;
}

.assignee-option:hover {
  background: var(--color-hover);
}
</style>
