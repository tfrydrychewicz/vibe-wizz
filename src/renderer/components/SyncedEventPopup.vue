<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { X, Cloud, Users, FileText, Search, ExternalLink, Unlink } from 'lucide-vue-next'
import type { CalendarEvent } from './MeetingModal.vue'
import type { OpenMode } from '../stores/tabStore'

const props = defineProps<{
  event: CalendarEvent
  position: { x: number; y: number }
}>()

const emit = defineEmits<{
  close: []
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
  'note-linked': [{ eventId: number; linkedNoteId: string; linkedNoteTitle: string }]
  'note-unlinked': [{ eventId: number }]
}>()

// ── Source name ───────────────────────────────────────────────────────────────

const sourceName = ref<string | null>(null)

// ── Note link state (mirrors event, but updates locally after linking) ────────

const linkedNoteId = ref(props.event.linked_note_id)
const linkedNoteTitle = ref(props.event.linked_note_title)

// ── Note search ───────────────────────────────────────────────────────────────

const showSearch = ref(false)
const noteQuery = ref('')
const noteResults = ref<{ id: string; title: string }[]>([])
const searchTimeout = ref<ReturnType<typeof setTimeout> | null>(null)

// ── Popup element ref (used for click-outside detection) ─────────────────────

const popupEl = ref<HTMLElement | null>(null)

// ── Computed position — clamp to viewport ────────────────────────────────────

const posStyle = computed(() => {
  const POPUP_W = 320
  const POPUP_H = 340
  const x = Math.min(props.position.x + 8, window.innerWidth - POPUP_W - 8)
  const y = Math.min(props.position.y, window.innerHeight - POPUP_H - 8)
  return { left: `${Math.max(8, x)}px`, top: `${Math.max(8, y)}px` }
})

// ── Derived display values ────────────────────────────────────────────────────

function formatDateTime(startIso: string, endIso: string): string {
  const start = new Date(startIso)
  const end = new Date(endIso)
  const date = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  const startTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const endTime = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${startTime} – ${endTime}`
}

const dateTime = computed(() => formatDateTime(props.event.start_at, props.event.end_at))

const attendees = computed((): { name?: string; email: string }[] => {
  try { return JSON.parse(props.event.attendees) as { name?: string; email: string }[] }
  catch { return [] }
})

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(async () => {
  // Delayed click-outside listener so the opening click doesn't immediately close
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 60)

  // Load source display name
  if (props.event.source_id) {
    const sources = await window.api.invoke('calendar-sources:list') as { id: string; name: string }[]
    const src = sources.find(s => s.id === props.event.source_id)
    if (src) sourceName.value = src.name
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onClickOutside)
  if (searchTimeout.value) clearTimeout(searchTimeout.value)
})

function onClickOutside(e: MouseEvent): void {
  if (popupEl.value && !popupEl.value.contains(e.target as Node)) {
    emit('close')
  }
}

// ── Note search ───────────────────────────────────────────────────────────────

function onNoteQueryInput(): void {
  if (searchTimeout.value) clearTimeout(searchTimeout.value)
  if (!noteQuery.value.trim()) { noteResults.value = []; return }
  searchTimeout.value = setTimeout(async () => {
    noteResults.value = (await window.api.invoke('notes:search', { query: noteQuery.value })) as { id: string; title: string }[]
  }, 200)
}

async function linkNote(note: { id: string; title: string }): Promise<void> {
  await window.api.invoke('calendar-events:update', { id: props.event.id, linked_note_id: note.id })
  linkedNoteId.value = note.id
  linkedNoteTitle.value = note.title
  showSearch.value = false
  noteQuery.value = ''
  noteResults.value = []
  emit('note-linked', { eventId: props.event.id, linkedNoteId: note.id, linkedNoteTitle: note.title })
}

async function unlinkNote(): Promise<void> {
  await window.api.invoke('calendar-events:update', { id: props.event.id, linked_note_id: null })
  linkedNoteId.value = null
  linkedNoteTitle.value = null
  emit('note-unlinked', { eventId: props.event.id })
}

function openNote(e: MouseEvent): void {
  if (!linkedNoteId.value || !linkedNoteTitle.value) return
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: linkedNoteId.value, title: linkedNoteTitle.value, mode })
  emit('close')
}
</script>

<template>
  <div ref="popupEl" class="synced-popup" :style="posStyle">
    <!-- Header -->
    <div class="sp-header">
      <div class="sp-title-row">
        <Cloud :size="13" class="sp-cloud-icon" />
        <span class="sp-title">{{ event.title }}</span>
      </div>
      <button class="sp-close" @click="emit('close')">
        <X :size="13" />
      </button>
    </div>

    <!-- Date / time -->
    <div class="sp-datetime">{{ dateTime }}</div>

    <!-- Attendees -->
    <div v-if="attendees.length" class="sp-section">
      <div class="sp-section-label">
        <Users :size="11" />
        Attendees
      </div>
      <div class="sp-attendees">
        <span
          v-for="a in attendees"
          :key="a.email"
          class="sp-attendee-chip"
          :title="a.email"
        >{{ a.name || a.email }}</span>
      </div>
    </div>

    <!-- Meeting Notes -->
    <div class="sp-section">
      <div class="sp-section-label">
        <FileText :size="11" />
        Meeting Notes
      </div>

      <!-- Linked note -->
      <div v-if="linkedNoteId && linkedNoteTitle" class="sp-linked-note">
        <button class="sp-note-chip" @click="openNote($event)">
          <ExternalLink :size="11" />
          {{ linkedNoteTitle }}
        </button>
        <button class="sp-unlink-btn" title="Unlink note" @click="unlinkNote">
          <Unlink :size="11" />
        </button>
      </div>

      <!-- Note search -->
      <template v-else>
        <button v-if="!showSearch" class="sp-link-btn" @click="showSearch = true">
          Link a note…
        </button>
        <template v-else>
          <div class="sp-search-row">
            <Search :size="12" class="sp-search-icon" />
            <input
              v-model="noteQuery"
              class="sp-search-input"
              placeholder="Search notes…"
              autofocus
              @input="onNoteQueryInput"
            />
          </div>
          <div v-if="noteResults.length" class="sp-note-results">
            <button
              v-for="note in noteResults"
              :key="note.id"
              class="sp-note-result"
              @click="linkNote(note)"
            >{{ note.title }}</button>
          </div>
        </template>
      </template>
    </div>

    <!-- Source badge -->
    <div class="sp-footer">
      <Cloud :size="10" class="sp-footer-icon" />
      <span>{{ sourceName ?? 'Synced from external calendar' }}</span>
    </div>
  </div>
</template>

<style scoped>
.synced-popup {
  position: fixed;
  z-index: 1200;
  width: 300px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.16);
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow: hidden;
  font-size: 13px;
}

/* ── Header ──────────────────────────────────────────────────────────────── */

.sp-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 12px 8px;
}

.sp-title-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  flex: 1;
}

.sp-cloud-icon {
  color: #4ade80;
  flex-shrink: 0;
  margin-top: 2px;
}

.sp-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  line-height: 1.3;
  word-break: break-word;
}

.sp-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.sp-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

/* ── Datetime ────────────────────────────────────────────────────────────── */

.sp-datetime {
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 0 12px 10px;
}

/* ── Sections ────────────────────────────────────────────────────────────── */

.sp-section {
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sp-section-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
}

/* ── Attendees ───────────────────────────────────────────────────────────── */

.sp-attendees {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.sp-attendee-chip {
  font-size: 11px;
  color: var(--color-text);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 2px 6px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Linked note ─────────────────────────────────────────────────────────── */

.sp-linked-note {
  display: flex;
  align-items: center;
  gap: 6px;
}

.sp-note-chip {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--color-accent);
  background: rgba(91, 141, 239, 0.1);
  border: 1px solid rgba(91, 141, 239, 0.25);
  border-radius: 5px;
  padding: 3px 8px;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.sp-note-chip:hover {
  background: rgba(91, 141, 239, 0.18);
}

.sp-unlink-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

.sp-unlink-btn:hover {
  background: rgba(239, 68, 68, 0.1);
  border-color: rgba(239, 68, 68, 0.35);
  color: #ef4444;
}

.sp-link-btn {
  font-size: 12px;
  color: var(--color-text-muted);
  background: transparent;
  border: 1px dashed var(--color-border);
  border-radius: 5px;
  padding: 5px 10px;
  cursor: pointer;
  text-align: left;
  width: 100%;
}

.sp-link-btn:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
  background: rgba(91, 141, 239, 0.05);
}

/* ── Note search ─────────────────────────────────────────────────────────── */

.sp-search-row {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  padding: 5px 8px;
}

.sp-search-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.sp-search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 12px;
  color: var(--color-text);
  font-family: inherit;
}

.sp-note-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 120px;
  overflow-y: auto;
}

.sp-note-result {
  text-align: left;
  font-size: 12px;
  color: var(--color-text);
  background: transparent;
  border: none;
  border-radius: 4px;
  padding: 5px 8px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sp-note-result:hover {
  background: var(--color-hover);
}

/* ── Footer ──────────────────────────────────────────────────────────────── */

.sp-footer {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 12px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-muted);
  background: rgba(74, 222, 128, 0.05);
}

.sp-footer-icon {
  color: #4ade80;
  flex-shrink: 0;
}
</style>
