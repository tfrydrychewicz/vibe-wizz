<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { X, Plus, Trash2, ExternalLink, FileText } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'
import type { OpenMode } from '../stores/tabStore'

export interface CalendarEvent {
  id: number
  external_id: string | null
  title: string
  start_at: string
  end_at: string
  attendees: string       // raw JSON string
  linked_note_id: string | null
  transcript_note_id: string | null
  recurrence_rule: string | null
  synced_at: string
  linked_note_title: string | null
}

const props = defineProps<{
  event: CalendarEvent | null   // null = create mode
  defaultStart: string          // ISO 8601, used when event is null
  defaultEnd?: string           // ISO 8601, optional end time override for create mode
}>()

const emit = defineEmits<{
  saved: [event: CalendarEvent]
  deleted: []
  cancel: []
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

// ── Attendee config ───────────────────────────────────────────────────────────

interface AttendeeItem {
  name: string
  email: string
  entity_id?: string
}

interface AttendeeConfig {
  typeId: string
  nameField: string
  emailField: string
}

const attendeeConfig = ref<AttendeeConfig | null>(null)

// ── Form state ────────────────────────────────────────────────────────────────

const title = ref('')
const dateStr = ref('')   // YYYY-MM-DD
const startTime = ref('') // HH:MM
const endTime = ref('')   // HH:MM
const attendees = ref<AttendeeItem[]>([])
const linkedNoteId = ref<string | null>(null)
const linkedNoteTitle = ref<string | null>(null)
const confirmDelete = ref(false)
const saving = ref(false)
const saveError = ref<string | null>(null)
const creatingNote = ref(false)

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoToDateStr(iso: string): string {
  return iso.slice(0, 10)
}

function isoToTimeStr(iso: string): string {
  // Parse as local time — the ISO strings we store use local time without Z
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '09:00'
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

function buildISO(date: string, time: string): string {
  // Combine YYYY-MM-DD + HH:MM → local datetime ISO string without Z
  const [y, mo, d] = date.split('-').map(Number)
  const [h, min] = time.split(':').map(Number)
  const dt = new Date(y, mo - 1, d, h, min, 0, 0)
  // Format as YYYY-MM-DDTHH:MM:SS.mmmZ equivalent but in local representation
  return dt.toISOString()
}

// ── Populate form ─────────────────────────────────────────────────────────────

function populate(): void {
  if (props.event) {
    title.value = props.event.title
    dateStr.value = isoToDateStr(props.event.start_at)
    startTime.value = isoToTimeStr(props.event.start_at)
    endTime.value = isoToTimeStr(props.event.end_at)
    try {
      attendees.value = JSON.parse(props.event.attendees) as Array<{ name: string; email: string }>
    } catch {
      attendees.value = []
    }
    linkedNoteId.value = props.event.linked_note_id
    linkedNoteTitle.value = props.event.linked_note_title
  } else {
    // Create mode — pre-fill from defaultStart
    const start = new Date(props.defaultStart)
    if (!isNaN(start.getTime())) {
      dateStr.value = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
      startTime.value = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
      // End time: from defaultEnd if provided, otherwise default 1 hour
      if (props.defaultEnd) {
        const end = new Date(props.defaultEnd)
        endTime.value = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
      } else {
        const end = new Date(start.getTime() + 60 * 60 * 1000)
        endTime.value = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
      }
    } else {
      dateStr.value = new Date().toISOString().slice(0, 10)
      startTime.value = '09:00'
      endTime.value = '10:00'
    }
    title.value = ''
    attendees.value = []
    linkedNoteId.value = null
    linkedNoteTitle.value = null
  }
  confirmDelete.value = false
  noteSearchQuery.value = ''
  showNoteDropdown.value = false
}

onMounted(async () => {
  populate()
  const [typeId, nameField, emailField] = await Promise.all([
    window.api.invoke('settings:get', { key: 'attendee_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_name_field' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_email_field' }) as Promise<string | null>,
  ])
  if (typeId && nameField && emailField) {
    attendeeConfig.value = { typeId, nameField, emailField }
  }
})
watch(() => props.event, populate)
watch(() => props.defaultStart, populate)

// ── Attendees — free-form mode ────────────────────────────────────────────────

const newAttendeeName = ref('')
const newAttendeeEmail = ref('')

function addAttendee(): void {
  const name = newAttendeeName.value.trim()
  const email = newAttendeeEmail.value.trim()
  if (!name && !email) return
  attendees.value.push({ name, email })
  newAttendeeName.value = ''
  newAttendeeEmail.value = ''
}

function removeAttendee(idx: number): void {
  attendees.value.splice(idx, 1)
}

function onAttendeeKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') {
    e.preventDefault()
    addAttendee()
  }
}

// ── Attendees — entity search mode ───────────────────────────────────────────

interface EntitySearchResult {
  id: string
  name: string
  type_icon: string
}

const attendeeQuery = ref('')
const attendeeResults = ref<EntitySearchResult[]>([])
const showAttendeeDropdown = ref(false)
const attendeeDropdownIdx = ref(0)
const attendeeSearchInputEl = ref<HTMLInputElement | null>(null)
const attendeeDropdownPos = ref({ top: 0, left: 0, width: 0 })

function updateDropdownPos(): void {
  const el = attendeeSearchInputEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  attendeeDropdownPos.value = { top: rect.bottom + 4, left: rect.left, width: rect.width }
}

watch(attendeeQuery, async (q) => {
  if (!attendeeConfig.value || !q.trim()) {
    attendeeResults.value = []
    showAttendeeDropdown.value = false
    return
  }
  attendeeResults.value = (await window.api.invoke('entities:search', {
    query: q,
    type_id: attendeeConfig.value.typeId,
  })) as EntitySearchResult[]
  if (attendeeResults.value.length > 0) {
    updateDropdownPos()
    showAttendeeDropdown.value = true
  } else {
    showAttendeeDropdown.value = false
  }
  attendeeDropdownIdx.value = 0
})

async function selectAttendeeEntity(result: EntitySearchResult): Promise<void> {
  const cfg = attendeeConfig.value!
  const res = (await window.api.invoke('entities:get', { id: result.id })) as {
    entity: { id: string; name: string; fields: string }
  } | null
  if (!res) return
  const { entity } = res
  const fields = JSON.parse(entity.fields ?? '{}') as Record<string, string>
  const name = cfg.nameField === '__name__' ? entity.name : (fields[cfg.nameField] ?? entity.name)
  const email = cfg.emailField === '__name__' ? entity.name : (fields[cfg.emailField] ?? '')
  if (!attendees.value.some(a => a.entity_id === entity.id)) {
    attendees.value.push({ name, email, entity_id: entity.id })
  }
  attendeeQuery.value = ''
  showAttendeeDropdown.value = false
}

function closeAttendeeDropdownDelayed(): void {
  window.setTimeout(() => { showAttendeeDropdown.value = false }, 150)
}

function onAttendeeSearchKeydown(e: KeyboardEvent): void {
  if (!showAttendeeDropdown.value || !attendeeResults.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    attendeeDropdownIdx.value = (attendeeDropdownIdx.value + 1) % attendeeResults.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    attendeeDropdownIdx.value = (attendeeDropdownIdx.value - 1 + attendeeResults.value.length) % attendeeResults.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void selectAttendeeEntity(attendeeResults.value[attendeeDropdownIdx.value])
  } else if (e.key === 'Escape') {
    showAttendeeDropdown.value = false
  }
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  const t = title.value.trim()
  if (!t || !dateStr.value) return
  saving.value = true
  saveError.value = null
  try {
    const start_at = buildISO(dateStr.value, startTime.value)
    const end_at = buildISO(dateStr.value, endTime.value)

    const attendeesPayload = attendees.value.map(a => ({
      name: a.name,
      email: a.email,
      ...(a.entity_id ? { entity_id: a.entity_id } : {}),
    }))

    if (props.event) {
      await window.api.invoke('calendar-events:update', {
        id: props.event.id,
        title: t,
        start_at,
        end_at,
        attendees: attendeesPayload,
        linked_note_id: linkedNoteId.value,
      })
      emit('saved', {
        ...props.event,
        title: t,
        start_at,
        end_at,
        attendees: JSON.stringify(attendees.value),
        linked_note_id: linkedNoteId.value,
        linked_note_title: linkedNoteTitle.value,
      })
    } else {
      const created = await window.api.invoke('calendar-events:create', {
        title: t,
        start_at,
        end_at,
        attendees: attendeesPayload,
        linked_note_id: linkedNoteId.value,
      }) as CalendarEvent
      emit('saved', created)
    }
  } catch (err) {
    console.error('[MeetingModal] save failed:', err)
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

async function deleteEvent(): Promise<void> {
  if (!props.event) return
  await window.api.invoke('calendar-events:delete', { id: props.event.id })
  emit('deleted')
}

// ── Open linked note ──────────────────────────────────────────────────────────

function openLinkedNote(e: MouseEvent): void {
  if (!linkedNoteId.value || !linkedNoteTitle.value) return
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: linkedNoteId.value, title: linkedNoteTitle.value, mode })
}

// ── Note search (attach existing note) ────────────────────────────────────────

const noteSearchQuery = ref('')
const noteSearchResults = ref<Array<{ id: string; title: string }>>([])
const showNoteDropdown = ref(false)
const noteDropdownIdx = ref(0)
const noteSearchInputEl = ref<HTMLInputElement | null>(null)
const noteDropdownPos = ref({ top: 0, left: 0, width: 0 })

function updateNoteDropdownPos(): void {
  const el = noteSearchInputEl.value
  if (!el) return
  const rect = el.getBoundingClientRect()
  noteDropdownPos.value = { top: rect.bottom + 4, left: rect.left, width: rect.width }
}

watch(noteSearchQuery, async (q) => {
  if (!q.trim()) {
    noteSearchResults.value = []
    showNoteDropdown.value = false
    return
  }
  noteSearchResults.value = (await window.api.invoke('notes:search', { query: q })) as Array<{ id: string; title: string }>
  if (noteSearchResults.value.length > 0) {
    updateNoteDropdownPos()
    showNoteDropdown.value = true
  } else {
    showNoteDropdown.value = false
  }
  noteDropdownIdx.value = 0
})

async function selectNoteResult(result: { id: string; title: string }): Promise<void> {
  linkedNoteId.value = result.id
  linkedNoteTitle.value = result.title
  noteSearchQuery.value = ''
  showNoteDropdown.value = false
  if (props.event) {
    await window.api.invoke('calendar-events:update', { id: props.event.id, linked_note_id: result.id })
    emit('saved', { ...props.event, linked_note_id: result.id, linked_note_title: result.title })
  }
}

function closeNoteDropdownDelayed(): void {
  window.setTimeout(() => { showNoteDropdown.value = false }, 150)
}

function onNoteSearchKeydown(e: KeyboardEvent): void {
  if (!showNoteDropdown.value || !noteSearchResults.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    noteDropdownIdx.value = (noteDropdownIdx.value + 1) % noteSearchResults.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    noteDropdownIdx.value = (noteDropdownIdx.value - 1 + noteSearchResults.value.length) % noteSearchResults.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void selectNoteResult(noteSearchResults.value[noteDropdownIdx.value])
  } else if (e.key === 'Escape') {
    showNoteDropdown.value = false
  }
}

// ── Create meeting note ────────────────────────────────────────────────────────

async function createMeetingNote(e: MouseEvent): Promise<void> {
  if (!props.event || creatingNote.value) return
  creatingNote.value = true
  try {
    const template = (await window.api.invoke('settings:get', { key: 'meeting_note_title_template' }) as string | null) ?? '{date} - {title}'
    const start = new Date(props.event.start_at)
    const datePart = start.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    const noteTitle = template
      .replace('{date}', datePart)
      .replace('{title}', props.event.title)
    const note = (await window.api.invoke('notes:create', { title: noteTitle })) as { id: string; title: string }
    await window.api.invoke('calendar-events:update', { id: props.event.id, linked_note_id: note.id })
    linkedNoteId.value = note.id
    linkedNoteTitle.value = noteTitle
    const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
    emit('open-note', { noteId: note.id, title: noteTitle, mode })
    emit('saved', { ...props.event, linked_note_id: note.id, linked_note_title: noteTitle })
  } finally {
    creatingNote.value = false
  }
}
</script>

<template>
  <div class="modal-overlay" @mousedown.self="emit('cancel')">
    <div class="modal-card" role="dialog" aria-modal="true">
      <!-- Header -->
      <div class="modal-header">
        <h2 class="modal-title">{{ event ? 'Edit Meeting' : 'New Meeting' }}</h2>
        <button class="btn-icon" @click="emit('cancel')"><X :size="15" /></button>
      </div>

      <!-- Body -->
      <div class="modal-body">
        <!-- Title -->
        <div class="field">
          <label class="field-label">Title</label>
          <input
            v-model="title"
            class="field-input"
            placeholder="Meeting title…"
            autofocus
            @keydown.enter="save"
          />
        </div>

        <!-- Date + Times -->
        <div class="field field-row">
          <div class="field field-shrink">
            <label class="field-label">Date</label>
            <input v-model="dateStr" type="date" class="field-input" />
          </div>
          <div class="field field-shrink">
            <label class="field-label">Start</label>
            <input v-model="startTime" type="time" class="field-input" />
          </div>
          <div class="field field-shrink">
            <label class="field-label">End</label>
            <input v-model="endTime" type="time" class="field-input" />
          </div>
        </div>

        <!-- Attendees -->
        <div class="field">
          <label class="field-label">Attendees</label>
          <div v-if="attendees.length" class="attendee-list">
            <div v-for="(a, idx) in attendees" :key="idx" class="attendee-chip">
              <span class="attendee-name">{{ a.name || a.email }}</span>
              <span v-if="a.name && a.email" class="attendee-email">{{ a.email }}</span>
              <button class="btn-remove" @click="removeAttendee(idx)"><X :size="10" /></button>
            </div>
          </div>

          <!-- Entity search mode -->
          <template v-if="attendeeConfig">
            <div class="attendee-search-wrap">
              <input
                ref="attendeeSearchInputEl"
                v-model="attendeeQuery"
                class="field-input"
                placeholder="Search entities…"
                autocomplete="off"
                @keydown="onAttendeeSearchKeydown"
                @blur="closeAttendeeDropdownDelayed"
              />
            </div>
            <Teleport to="body">
              <div
                v-if="showAttendeeDropdown && attendeeResults.length"
                class="attendee-dropdown-portal"
                :style="{ top: attendeeDropdownPos.top + 'px', left: attendeeDropdownPos.left + 'px', width: attendeeDropdownPos.width + 'px' }"
              >
                <button
                  v-for="(r, i) in attendeeResults"
                  :key="r.id"
                  class="attendee-dropdown-item"
                  :class="{ active: i === attendeeDropdownIdx }"
                  @mousedown.prevent="selectAttendeeEntity(r)"
                >
                  <LucideIcon :name="r.type_icon" :size="12" />
                  {{ r.name }}
                </button>
              </div>
            </Teleport>
          </template>

          <!-- Free-form mode -->
          <template v-else>
            <div class="attendee-add-row">
              <input
                v-model="newAttendeeName"
                class="field-input attendee-input"
                placeholder="Name"
                @keydown="onAttendeeKeydown"
              />
              <input
                v-model="newAttendeeEmail"
                class="field-input attendee-input"
                placeholder="Email"
                @keydown="onAttendeeKeydown"
              />
              <button class="btn-add-attendee" title="Add attendee" @click="addAttendee">
                <Plus :size="13" />
              </button>
            </div>
          </template>
        </div>

        <!-- Meeting Notes -->
        <div v-if="event" class="field">
          <label class="field-label">Meeting Notes</label>
          <div v-if="linkedNoteId && linkedNoteTitle" class="linked-note-row">
            <button class="linked-note-title" @click="openLinkedNote">
              <ExternalLink :size="11" />
              {{ linkedNoteTitle }}
            </button>
            <button class="btn-icon btn-unlink" title="Unlink note" @click="linkedNoteId = null; linkedNoteTitle = null">
              <X :size="11" />
            </button>
          </div>
          <template v-else>
            <button class="btn-create-note" :disabled="creatingNote" @click="createMeetingNote">
              <FileText :size="12" />
              {{ creatingNote ? 'Creating…' : 'Create Meeting Notes' }}
            </button>
            <div class="note-attach-wrap">
              <input
                ref="noteSearchInputEl"
                v-model="noteSearchQuery"
                class="field-input note-attach-input"
                placeholder="or attach existing note…"
                autocomplete="off"
                @keydown="onNoteSearchKeydown"
                @blur="closeNoteDropdownDelayed"
              />
            </div>
            <Teleport to="body">
              <div
                v-if="showNoteDropdown && noteSearchResults.length"
                class="attendee-dropdown-portal"
                :style="{ top: noteDropdownPos.top + 'px', left: noteDropdownPos.left + 'px', width: noteDropdownPos.width + 'px' }"
              >
                <button
                  v-for="(r, i) in noteSearchResults"
                  :key="r.id"
                  class="attendee-dropdown-item"
                  :class="{ active: i === noteDropdownIdx }"
                  @mousedown.prevent="selectNoteResult(r)"
                >
                  <FileText :size="12" />
                  {{ r.title }}
                </button>
              </div>
            </Teleport>
          </template>
        </div>
      </div>

      <!-- Error -->
      <div v-if="saveError" class="save-error">{{ saveError }}</div>

      <!-- Footer -->
      <div class="modal-footer">
        <div class="footer-left">
          <template v-if="event">
            <button
              v-if="!confirmDelete"
              class="btn-danger-outline"
              @click="confirmDelete = true"
            >
              <Trash2 :size="13" />
              Delete
            </button>
            <template v-else>
              <span class="confirm-text">Delete this meeting?</span>
              <button class="btn-danger" @click="deleteEvent">Yes, delete</button>
              <button class="btn-ghost" @click="confirmDelete = false">Cancel</button>
            </template>
          </template>
        </div>
        <div class="footer-right">
          <button class="btn-ghost" @click="emit('cancel')">Cancel</button>
          <button class="btn-primary" :disabled="!title.trim() || saving" @click="save">
            {{ saving ? 'Saving…' : (event ? 'Save' : 'Create') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  width: 480px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.field-input {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 7px 10px;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  outline: none;
  width: 100%;
  box-sizing: border-box;
}

.field-input:focus {
  border-color: var(--color-accent);
}

.field-row {
  flex-direction: row;
  gap: 10px;
  align-items: flex-end;
}

.field-shrink {
  flex-shrink: 0;
  flex: 1;
}

/* Attendees — entity search */

.attendee-search-wrap {
  position: relative;
}

:global(.attendee-dropdown-portal) {
  position: fixed;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  z-index: 2000;
  overflow: hidden;
  max-height: 200px;
  overflow-y: auto;
}

:global(.attendee-dropdown-item) {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
}

:global(.attendee-dropdown-item:hover),
:global(.attendee-dropdown-item.active) {
  background: rgba(91, 141, 239, 0.12);
}

/* Attendees */

.attendee-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.attendee-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  background: rgba(91, 141, 239, 0.12);
  border: 1px solid rgba(91, 141, 239, 0.3);
  border-radius: 20px;
  padding: 3px 8px 3px 10px;
  font-size: 12px;
  color: var(--color-text);
}

.attendee-name {
  font-weight: 500;
}

.attendee-email {
  color: var(--color-text-muted);
  font-size: 11px;
}

.btn-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 1px;
  border-radius: 50%;
  line-height: 1;
}

.btn-remove:hover {
  color: var(--color-text);
}

.attendee-add-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.attendee-input {
  flex: 1;
}

.btn-add-attendee {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.btn-add-attendee:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

/* Linked note */

.linked-note-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 6px 10px;
}

.linked-note-title {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: var(--color-accent);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  padding: 0;
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.linked-note-title:hover {
  text-decoration: underline;
}

.btn-unlink {
  color: var(--color-text-muted);
}

/* Create meeting note button */

.btn-create-note {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--color-bg);
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  padding: 7px 12px;
  cursor: pointer;
  width: 100%;
  justify-content: center;
}

.btn-create-note:hover:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.btn-create-note:disabled {
  opacity: 0.5;
  cursor: default;
}

.note-attach-wrap {
  position: relative;
  margin-top: 6px;
}

.note-attach-input {
  width: 100%;
  box-sizing: border-box;
  font-size: 12px;
  color: var(--color-text-muted);
}

/* Save error */

.save-error {
  padding: 8px 20px;
  font-size: 12px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border-top: 1px solid rgba(239, 68, 68, 0.2);
  flex-shrink: 0;
}

/* Footer */

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
  gap: 8px;
}

.footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.confirm-text {
  font-size: 12px;
  color: var(--color-text-muted);
}

/* Buttons */

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
}

.btn-icon:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.btn-primary {
  padding: 7px 16px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.4;
  cursor: default;
}

.btn-ghost {
  padding: 7px 14px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}

.btn-ghost:hover {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.btn-danger-outline {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 12px;
  background: transparent;
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 6px;
  color: #ef4444;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}

.btn-danger-outline:hover {
  background: rgba(239, 68, 68, 0.08);
}

.btn-danger {
  padding: 7px 14px;
  background: #ef4444;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  font-weight: 500;
}

.btn-danger:hover {
  opacity: 0.9;
}
</style>
