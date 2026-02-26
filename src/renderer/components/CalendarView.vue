<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { ChevronLeft, ChevronRight, Calendar, Plus, RefreshCw, Cloud } from 'lucide-vue-next'
import MeetingModal from './MeetingModal.vue'
import SyncedEventPopup from './SyncedEventPopup.vue'
import type { CalendarEvent } from './MeetingModal.vue'
import type { OpenMode } from '../stores/tabStore'

const emit = defineEmits<{
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

// ── Types ─────────────────────────────────────────────────────────────────────

type CalendarViewMode = 'day' | 'work-week' | 'week' | 'month'

// ── State ─────────────────────────────────────────────────────────────────────

const viewMode = ref<CalendarViewMode>('week')
const currentDate = ref(new Date())
const events = ref<CalendarEvent[]>([])
const loading = ref(false)

// Modal (locally-created events)
const showModal = ref(false)
const modalEvent = ref<CalendarEvent | null>(null)
const modalDefaultStart = ref('')
const modalDefaultEnd = ref('')

// Synced event info popup
const syncedPopupEvent = ref<CalendarEvent | null>(null)
const syncedPopupPos = ref({ x: 0, y: 0 })

// Slot duration (minutes) loaded from settings
const slotDuration = ref(30)

// Drag-to-create state
interface DragState {
  day: Date
  startMinutes: number
  endMinutes: number
}
const activeDrag = ref<DragState | null>(null)

// Move-event drag
interface MoveDragState {
  event: CalendarEvent
  offsetMinutes: number  // how far into the event the user clicked
  currentDay: Date
  currentStartMinutes: number
  startX: number
  startY: number
  hasMoved: boolean
}
const moveDrag = ref<MoveDragState | null>(null)

// Resize-event drag
interface ResizeDragState {
  event: CalendarEvent
  currentEndMinutes: number
}
const resizeDrag = ref<ResizeDragState | null>(null)

// Time grid constants (7am–9pm = 14 hours)
const HOUR_START = 7
const HOUR_END = 21
const NUM_HOURS = HOUR_END - HOUR_START

// Responsive hour height — fills the scroll container exactly
const gridScrollRef = ref<HTMLElement | null>(null)
const containerHeight = ref(0)
// Cells are at least 56px tall; if the container has more room they grow to fill it
const hourHeight = computed(() =>
  containerHeight.value > 0 ? Math.max(56, containerHeight.value / NUM_HOURS) : 56
)

let resizeObserver: ResizeObserver | null = null
let _calSyncUnsub: (() => void) | null = null

// ── Date helpers ──────────────────────────────────────────────────────────────

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function startOfWeek(d: Date, startOnMonday = false): Date {
  const day = d.getDay()
  const diff = startOnMonday ? (day === 0 ? -6 : 1 - day) : -day
  return startOfDay(addDays(d, diff))
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function isToday(d: Date): boolean {
  return isSameDay(d, new Date())
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

function formatDate(d: Date): string {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`
}

function formatDateShort(d: Date): string {
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`
}

// ── Range computation ─────────────────────────────────────────────────────────

const rangeStart = computed((): Date => {
  switch (viewMode.value) {
    case 'day':
      return startOfDay(currentDate.value)
    case 'work-week': {
      const sun = startOfWeek(currentDate.value, false)
      return addDays(sun, 1) // Monday
    }
    case 'week':
      return startOfWeek(currentDate.value, false) // Sunday
    case 'month': {
      const som = startOfMonth(currentDate.value)
      return startOfWeek(som, false) // Sunday of the week containing the 1st
    }
  }
})

const rangeEnd = computed((): Date => {
  switch (viewMode.value) {
    case 'day':
      return addDays(rangeStart.value, 1)
    case 'work-week':
      return addDays(rangeStart.value, 5) // Mon–Fri, exclusive end
    case 'week':
      return addDays(rangeStart.value, 7)
    case 'month': {
      const eom = endOfMonth(currentDate.value)
      const lastSun = startOfWeek(eom, false)
      return addDays(lastSun, 7) // end of last week row
    }
  }
})

const headerTitle = computed((): string => {
  switch (viewMode.value) {
    case 'day':
      return formatDate(currentDate.value)
    case 'work-week':
    case 'week': {
      const end = addDays(rangeEnd.value, -1)
      return `${formatDateShort(rangeStart.value)} – ${formatDateShort(end)}, ${end.getFullYear()}`
    }
    case 'month':
      return `${MONTH_NAMES[currentDate.value.getMonth()]} ${currentDate.value.getFullYear()}`
  }
})

// ── Columns for time-grid views ───────────────────────────────────────────────

const columns = computed((): Date[] => {
  if (viewMode.value === 'month') return []
  const cols: Date[] = []
  let d = new Date(rangeStart.value)
  const end = rangeEnd.value
  while (d < end) {
    cols.push(new Date(d))
    d = addDays(d, 1)
  }
  return cols
})

// ── Month grid ────────────────────────────────────────────────────────────────

const monthWeeks = computed((): Date[][] => {
  if (viewMode.value !== 'month') return []
  const weeks: Date[][] = []
  let d = new Date(rangeStart.value)
  const end = rangeEnd.value
  while (d < end) {
    const week: Date[] = []
    for (let i = 0; i < 7; i++) {
      week.push(new Date(d))
      d = addDays(d, 1)
    }
    weeks.push(week)
  }
  return weeks
})

const currentMonthIndex = computed(() => currentDate.value.getMonth())

// ── Data fetching ─────────────────────────────────────────────────────────────

async function loadEvents(): Promise<void> {
  loading.value = true
  try {
    events.value = (await window.api.invoke('calendar-events:list', {
      start_at: rangeStart.value.toISOString(),
      end_at: rangeEnd.value.toISOString(),
    })) as CalendarEvent[]
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  void loadEvents()
  const [slotSetting, viewSetting] = await Promise.all([
    window.api.invoke('settings:get', { key: 'calendar_slot_duration' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'calendar_view_mode' }) as Promise<string | null>,
  ])
  slotDuration.value = slotSetting ? parseInt(slotSetting, 10) : 30
  if (viewSetting && ['day', 'work-week', 'week', 'month'].includes(viewSetting)) {
    viewMode.value = viewSetting as CalendarViewMode
  }
  if (gridScrollRef.value) {
    containerHeight.value = gridScrollRef.value.clientHeight
    resizeObserver = new ResizeObserver(([entry]) => {
      containerHeight.value = entry.contentRect.height
    })
    resizeObserver.observe(gridScrollRef.value)
  }
  // Reload events when a background sync completes for any source
  _calSyncUnsub = window.api.on('calendar-sync:complete', () => { void loadEvents() })
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  _calSyncUnsub?.()
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('mousemove', onGlobalMouseMove)
  window.removeEventListener('mouseup', onGlobalMouseUp)
  window.removeEventListener('mousemove', onMoveMouseMove)
  window.removeEventListener('mouseup', onMoveMouseUp)
  window.removeEventListener('mousemove', onResizeMouseMove)
  window.removeEventListener('mouseup', onResizeMouseUp)
})

watch([rangeStart, rangeEnd], loadEvents)
watch(viewMode, (mode) => {
  void window.api.invoke('settings:set', { key: 'calendar_view_mode', value: mode })
})

// ── Navigation ────────────────────────────────────────────────────────────────

function navigate(dir: 1 | -1): void {
  const d = new Date(currentDate.value)
  switch (viewMode.value) {
    case 'day':
      d.setDate(d.getDate() + dir)
      break
    case 'work-week':
      d.setDate(d.getDate() + dir * 7)
      break
    case 'week':
      d.setDate(d.getDate() + dir * 7)
      break
    case 'month':
      d.setMonth(d.getMonth() + dir)
      break
  }
  currentDate.value = d
}

function goToday(): void {
  currentDate.value = new Date()
}

// ── Event layout (time grid) ──────────────────────────────────────────────────

function eventsForDay(day: Date): CalendarEvent[] {
  return events.value.filter((ev) => isSameDay(new Date(ev.start_at), day))
}

function eventTopPx(ev: CalendarEvent): number {
  const d = new Date(ev.start_at)
  const minutes = d.getHours() * 60 + d.getMinutes()
  return ((minutes - HOUR_START * 60) / 60) * hourHeight.value
}

function eventHeightPx(ev: CalendarEvent): number {
  const start = new Date(ev.start_at)
  const end = new Date(ev.end_at)
  const durationMinutes = (end.getTime() - start.getTime()) / 60000
  const clampedMin = Math.max(durationMinutes, 15) // minimum visible height
  return (clampedMin / 60) * hourHeight.value
}

function formatEventTime(iso: string): string {
  const d = new Date(iso)
  const h = d.getHours()
  const m = d.getMinutes()
  const ampm = h >= 12 ? 'pm' : 'am'
  const hour = h % 12 || 12
  return m === 0 ? `${hour}${ampm}` : `${hour}:${String(m).padStart(2, '0')}${ampm}`
}

// ── Recurrence helpers ────────────────────────────────────────────────────

function isRecurring(ev: CalendarEvent): boolean {
  return ev.recurrence_rule !== null || ev.recurrence_series_id !== null
}

function describeRule(ruleJson: string): string {
  try {
    const r = JSON.parse(ruleJson) as { freq?: string; days?: string[] }
    const days = r.days?.map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
    switch (r.freq) {
      case 'daily': return 'Daily'
      case 'weekly': return days ? `Weekly on ${days}` : 'Weekly'
      case 'biweekly': return days ? `Every 2 weeks on ${days}` : 'Every 2 weeks'
      case 'monthly': return 'Monthly'
      default: return 'Recurring'
    }
  } catch { return 'Recurring' }
}

function eventTooltip(ev: CalendarEvent): string {
  const time = `${formatEventTime(ev.start_at)}–${formatEventTime(ev.end_at)}`
  const recur = ev.recurrence_rule
    ? `↻ ${describeRule(ev.recurrence_rule)}`
    : ev.recurrence_series_id ? '↻ Recurring' : ''
  return recur ? `${ev.title}\n${time}\n${recur}` : `${ev.title}\n${time}`
}

// ── Synced event helpers ──────────────────────────────────────────────────────

function isSourced(ev: CalendarEvent): boolean {
  return ev.source_id !== null
}

function openSyncedPopup(ev: CalendarEvent, pos: { x: number; y: number }): void {
  syncedPopupEvent.value = ev
  syncedPopupPos.value = pos
}

function onSyncedNoteLinked(payload: { eventId: number; linkedNoteId: string; linkedNoteTitle: string }): void {
  const idx = events.value.findIndex(e => e.id === payload.eventId)
  if (idx !== -1) {
    events.value[idx] = { ...events.value[idx], linked_note_id: payload.linkedNoteId, linked_note_title: payload.linkedNoteTitle }
    if (syncedPopupEvent.value?.id === payload.eventId) {
      syncedPopupEvent.value = events.value[idx]
    }
  }
}

function onSyncedNoteUnlinked(payload: { eventId: number }): void {
  const idx = events.value.findIndex(e => e.id === payload.eventId)
  if (idx !== -1) {
    events.value[idx] = { ...events.value[idx], linked_note_id: null, linked_note_title: null }
    if (syncedPopupEvent.value?.id === payload.eventId) {
      syncedPopupEvent.value = events.value[idx]
    }
  }
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openCreateModal(defaultStart: string, defaultEnd?: string): void {
  modalEvent.value = null
  modalDefaultStart.value = defaultStart
  modalDefaultEnd.value = defaultEnd ?? ''
  showModal.value = true
}

function openEditModal(ev: CalendarEvent): void {
  modalEvent.value = ev
  modalDefaultStart.value = ev.start_at
  modalDefaultEnd.value = ''
  showModal.value = true
}

function onMonthDayClick(day: Date): void {
  const d = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 9, 0, 0)
  const end = new Date(d.getTime() + 60 * 60 * 1000)
  openCreateModal(d.toISOString(), end.toISOString())
}

// ── Drag-to-create ────────────────────────────────────────────────────────────

function getMinutesFromMouseY(clientY: number): number {
  if (!gridScrollRef.value) return HOUR_START * 60
  const scrollEl = gridScrollRef.value
  const rect = scrollEl.getBoundingClientRect()
  const y = clientY - rect.top + scrollEl.scrollTop
  const minutesSinceStart = (y / hourHeight.value) * 60
  const totalMinutes = HOUR_START * 60 + minutesSinceStart
  const snapped = Math.floor(totalMinutes / slotDuration.value) * slotDuration.value
  return Math.max(HOUR_START * 60, Math.min(HOUR_END * 60 - slotDuration.value, snapped))
}

function onDayMouseDown(day: Date, e: MouseEvent): void {
  if (e.button !== 0) return
  e.preventDefault()
  const startMinutes = getMinutesFromMouseY(e.clientY)
  activeDrag.value = { day, startMinutes, endMinutes: startMinutes + slotDuration.value }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onGlobalMouseMove)
  window.addEventListener('mouseup', onGlobalMouseUp)
}

function onGlobalMouseMove(e: MouseEvent): void {
  if (!activeDrag.value) return
  const currentMinutes = getMinutesFromMouseY(e.clientY)
  const endMinutes = Math.max(
    activeDrag.value.startMinutes + slotDuration.value,
    currentMinutes + slotDuration.value,
  )
  activeDrag.value = { ...activeDrag.value, endMinutes }
}

function onGlobalMouseUp(): void {
  document.body.style.userSelect = ''
  window.removeEventListener('mousemove', onGlobalMouseMove)
  window.removeEventListener('mouseup', onGlobalMouseUp)
  if (!activeDrag.value) return
  const { day, startMinutes, endMinutes } = activeDrag.value
  activeDrag.value = null
  const startDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
    Math.floor(startMinutes / 60), startMinutes % 60, 0)
  const endDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(),
    Math.floor(endMinutes / 60), endMinutes % 60, 0)
  openCreateModal(startDate.toISOString(), endDate.toISOString())
}

// ── Event display helpers ─────────────────────────────────────────────────────

function showEventTime(ev: CalendarEvent): boolean {
  return new Date(ev.end_at).getTime() - new Date(ev.start_at).getTime() >= 45 * 60 * 1000
}

function getEventDisplayStyle(ev: CalendarEvent): Record<string, string> {
  if (moveDrag.value?.event.id === ev.id) {
    // Fade original while ghost is shown at new position
    return { top: `${eventTopPx(ev)}px`, height: `${eventHeightPx(ev)}px`, opacity: '0.35' }
  }
  if (resizeDrag.value?.event.id === ev.id) {
    const startMinutes = new Date(ev.start_at).getHours() * 60 + new Date(ev.start_at).getMinutes()
    const heightPx = Math.max(
      slotDuration.value / 60 * hourHeight.value,
      (resizeDrag.value.currentEndMinutes - startMinutes) / 60 * hourHeight.value,
    )
    return { top: `${eventTopPx(ev)}px`, height: `${heightPx}px` }
  }
  return { top: `${eventTopPx(ev)}px`, height: `${eventHeightPx(ev)}px` }
}

// ── Move event (drag & drop) ───────────────────────────────────────────────────

function onEventMouseDown(ev: CalendarEvent, e: MouseEvent): void {
  if (e.button !== 0) return
  e.preventDefault()
  e.stopPropagation()
  // Synced events are read-only — still track the mousedown so a click opens the popup,
  // but use a simplified state that won't ghost/move the event.
  if (isSourced(ev)) {
    moveDrag.value = {
      event: ev,
      offsetMinutes: 0,
      currentDay: new Date(ev.start_at),
      currentStartMinutes: new Date(ev.start_at).getHours() * 60 + new Date(ev.start_at).getMinutes(),
      startX: e.clientX,
      startY: e.clientY,
      hasMoved: false,
    }
    window.addEventListener('mouseup', onMoveMouseUp)
    return
  }
  const eventStartMinutes = new Date(ev.start_at).getHours() * 60 + new Date(ev.start_at).getMinutes()
  const clickMinutes = getMinutesFromMouseY(e.clientY)
  moveDrag.value = {
    event: ev,
    offsetMinutes: Math.max(0, clickMinutes - eventStartMinutes),
    currentDay: new Date(ev.start_at),
    currentStartMinutes: eventStartMinutes,
    startX: e.clientX,
    startY: e.clientY,
    hasMoved: false,
  }
  document.body.style.userSelect = 'none'
  window.addEventListener('mousemove', onMoveMouseMove)
  window.addEventListener('mouseup', onMoveMouseUp)
}

function onDayMouseEnter(day: Date): void {
  if (moveDrag.value?.hasMoved) {
    moveDrag.value = { ...moveDrag.value, currentDay: day }
  }
}

function onMoveMouseMove(e: MouseEvent): void {
  if (!moveDrag.value) return
  if (isSourced(moveDrag.value.event)) return  // no drag for synced events
  const dx = Math.abs(e.clientX - moveDrag.value.startX)
  const dy = Math.abs(e.clientY - moveDrag.value.startY)
  if (dx < 4 && dy < 4) return
  if (!moveDrag.value.hasMoved) document.body.style.cursor = 'grabbing'
  const clickMinutes = getMinutesFromMouseY(e.clientY)
  const rawStart = clickMinutes - moveDrag.value.offsetMinutes
  const snapped = Math.round(rawStart / slotDuration.value) * slotDuration.value
  const eventDurationMin = (new Date(moveDrag.value.event.end_at).getTime() - new Date(moveDrag.value.event.start_at).getTime()) / 60000
  const clamped = Math.max(HOUR_START * 60, Math.min(HOUR_END * 60 - eventDurationMin, snapped))
  moveDrag.value = { ...moveDrag.value, hasMoved: true, currentStartMinutes: clamped }
}

function onMoveMouseUp(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('mousemove', onMoveMouseMove)
  window.removeEventListener('mouseup', onMoveMouseUp)
  if (!moveDrag.value) return
  const { event, currentDay, currentStartMinutes, hasMoved, startX, startY } = moveDrag.value
  moveDrag.value = null
  if (!hasMoved) {
    if (isSourced(event)) { openSyncedPopup(event, { x: startX, y: startY }); return }
    openEditModal(event); return
  }
  const durationMs = new Date(event.end_at).getTime() - new Date(event.start_at).getTime()
  const newStart = new Date(currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate(),
    Math.floor(currentStartMinutes / 60), currentStartMinutes % 60, 0)
  const newEnd = new Date(newStart.getTime() + durationMs)
  const newStartISO = newStart.toISOString()
  const newEndISO = newEnd.toISOString()
  if (newStartISO === event.start_at && newEndISO === event.end_at) return
  if (isSourced(event)) return  // should not reach here, but guard anyway
  const idx = events.value.findIndex((e) => e.id === event.id)
  if (idx !== -1) events.value[idx] = { ...event, start_at: newStartISO, end_at: newEndISO }
  void window.api.invoke('calendar-events:update', { id: event.id, start_at: newStartISO, end_at: newEndISO })
}

// ── Resize event (bottom edge drag) ──────────────────────────────────────────

function onResizeStart(ev: CalendarEvent, e: MouseEvent): void {
  if (e.button !== 0) return
  if (isSourced(ev)) return  // synced events are read-only
  e.preventDefault()
  e.stopPropagation()
  const end = new Date(ev.end_at)
  resizeDrag.value = { event: ev, currentEndMinutes: end.getHours() * 60 + end.getMinutes() }
  document.body.style.userSelect = 'none'
  document.body.style.cursor = 'ns-resize'
  window.addEventListener('mousemove', onResizeMouseMove)
  window.addEventListener('mouseup', onResizeMouseUp)
}

function onResizeMouseMove(e: MouseEvent): void {
  if (!resizeDrag.value) return
  const currentMinutes = getMinutesFromMouseY(e.clientY)
  const startMinutes = new Date(resizeDrag.value.event.start_at).getHours() * 60 + new Date(resizeDrag.value.event.start_at).getMinutes()
  const endMinutes = Math.min(HOUR_END * 60, Math.max(startMinutes + slotDuration.value, currentMinutes + slotDuration.value))
  resizeDrag.value = { ...resizeDrag.value, currentEndMinutes: endMinutes }
}

function onResizeMouseUp(): void {
  document.body.style.userSelect = ''
  document.body.style.cursor = ''
  window.removeEventListener('mousemove', onResizeMouseMove)
  window.removeEventListener('mouseup', onResizeMouseUp)
  if (!resizeDrag.value) return
  const { event, currentEndMinutes } = resizeDrag.value
  resizeDrag.value = null
  const origEndMinutes = new Date(event.end_at).getHours() * 60 + new Date(event.end_at).getMinutes()
  if (currentEndMinutes === origEndMinutes) return
  const startDate = new Date(event.start_at)
  const newEnd = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate(),
    Math.floor(currentEndMinutes / 60), currentEndMinutes % 60, 0)
  const newEndISO = newEnd.toISOString()
  const idx = events.value.findIndex((e) => e.id === event.id)
  if (idx !== -1) events.value[idx] = { ...event, end_at: newEndISO }
  void window.api.invoke('calendar-events:update', { id: event.id, end_at: newEndISO })
}

function onModalSaved(ev: CalendarEvent): void {
  showModal.value = false
  if (isRecurring(ev)) {
    // Scope changes may have added/removed occurrences in the current range
    void loadEvents()
  } else {
    const idx = events.value.findIndex((e) => e.id === ev.id)
    if (idx !== -1) {
      events.value[idx] = ev
    } else {
      events.value.push(ev)
      events.value.sort((a, b) => a.start_at.localeCompare(b.start_at))
    }
  }
}

function onModalDeleted(): void {
  showModal.value = false
  if (modalEvent.value && isRecurring(modalEvent.value)) {
    // Series delete may remove multiple occurrences
    void loadEvents()
  } else if (modalEvent.value) {
    const id = modalEvent.value.id
    events.value = events.value.filter((e) => e.id !== id)
  }
}

// ── Hours list ────────────────────────────────────────────────────────────────

const hours = Array.from({ length: HOUR_END - HOUR_START }, (_, i) => HOUR_START + i)
</script>

<template>
  <div class="calendar-view">
    <!-- Toolbar -->
    <div class="cal-toolbar">
      <div class="cal-nav">
        <button class="btn-nav" title="Previous" @click="navigate(-1)">
          <ChevronLeft :size="15" />
        </button>
        <button class="btn-today" @click="goToday">Today</button>
        <button class="btn-nav" title="Next" @click="navigate(1)">
          <ChevronRight :size="15" />
        </button>
      </div>

      <div class="cal-title">
        <Calendar :size="14" />
        <span>{{ headerTitle }}</span>
      </div>

      <div class="cal-actions">
        <div class="view-switcher">
          <button
            v-for="m in (['day', 'work-week', 'week', 'month'] as CalendarViewMode[])"
            :key="m"
            class="view-btn"
            :class="{ active: viewMode === m }"
            @click="viewMode = m"
          >
            {{ m === 'work-week' ? 'Work Week' : m === 'day' ? 'Day' : m === 'week' ? 'Week' : 'Month' }}
          </button>
        </div>
        <button class="btn-new-meeting" @click="openCreateModal(new Date().toISOString())">
          <Plus :size="13" />
          New
        </button>
      </div>
    </div>

    <!-- Time grid (day / work-week / week) -->
    <template v-if="viewMode !== 'month'">
      <!-- Column headers -->
      <div class="col-headers" :style="{ '--cols': columns.length }">
        <div class="time-gutter-header" />
        <div
          v-for="col in columns"
          :key="col.toISOString()"
          class="col-header"
          :class="{ 'col-today': isToday(col) }"
        >
          <span class="col-day-name">{{ DAY_NAMES[col.getDay()] }}</span>
          <span class="col-day-num" :class="{ 'day-today': isToday(col) }">{{ col.getDate() }}</span>
        </div>
      </div>

      <!-- Scrollable grid -->
      <div ref="gridScrollRef" class="time-grid-scroll">
        <div class="time-grid" :style="{ '--cols': columns.length, '--hour-height': `${hourHeight}px` }">
          <!-- Time gutter -->
          <div class="time-gutter">
            <div v-for="h in hours" :key="h" class="time-label">
              {{ h === 12 ? '12pm' : h > 12 ? `${h - 12}pm` : `${h}am` }}
            </div>
          </div>

          <!-- Day columns -->
          <div
            v-for="col in columns"
            :key="col.toISOString()"
            class="day-col"
            @mousedown.prevent="onDayMouseDown(col, $event)"
            @mouseenter="onDayMouseEnter(col)"
          >
            <!-- Hour slots (visual grid lines) -->
            <div
              v-for="h in hours"
              :key="h"
              class="hour-slot"
            />

            <!-- Drag-to-create preview -->
            <div
              v-if="activeDrag && isSameDay(activeDrag.day, col)"
              class="event-block drag-preview"
              :style="{
                top: `${(activeDrag.startMinutes - HOUR_START * 60) / 60 * hourHeight}px`,
                height: `${(activeDrag.endMinutes - activeDrag.startMinutes) / 60 * hourHeight}px`,
              }"
            />

            <!-- Move ghost (shows target position while dragging) -->
            <div
              v-if="moveDrag && moveDrag.hasMoved && isSameDay(moveDrag.currentDay, col)"
              class="event-block move-ghost"
              :style="{
                top: `${(moveDrag.currentStartMinutes - HOUR_START * 60) / 60 * hourHeight}px`,
                height: `${eventHeightPx(moveDrag.event)}px`,
              }"
            >
              <span class="event-title">{{ moveDrag.event.title }}</span>
            </div>

            <!-- Events -->
            <div
              v-for="ev in eventsForDay(col)"
              :key="ev.id"
              class="event-block"
              :class="{ 'is-synced': isSourced(ev) }"
              :style="getEventDisplayStyle(ev)"
              :title="eventTooltip(ev)"
              @mousedown.prevent.stop="onEventMouseDown(ev, $event)"
            >
              <div class="event-header-row">
                <span class="event-title">{{ ev.title }}</span>
                <RefreshCw v-if="isRecurring(ev)" :size="9" class="event-recur-icon" />
                <Cloud v-else-if="isSourced(ev)" :size="9" class="event-synced-icon" />
              </div>
              <span v-if="showEventTime(ev)" class="event-time">{{ formatEventTime(ev.start_at) }}</span>
              <div v-if="!isSourced(ev)" class="event-resize-handle" @mousedown.prevent.stop="onResizeStart(ev, $event)" />
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- Month grid -->
    <template v-else>
      <div class="month-grid">
        <!-- Day name headers -->
        <div v-for="name in DAY_NAMES" :key="name" class="month-day-name">{{ name }}</div>

        <!-- Day cells -->
        <template v-for="(week, wi) in monthWeeks" :key="wi">
          <div
            v-for="day in week"
            :key="day.toISOString()"
            class="month-day-cell"
            :class="{
              'month-day-today': isToday(day),
              'month-day-other': day.getMonth() !== currentMonthIndex,
            }"
            @click="onMonthDayClick(day)"
          >
            <span class="month-day-num">{{ day.getDate() }}</span>
            <div class="month-events">
              <div
                v-for="ev in eventsForDay(day)"
                :key="ev.id"
                class="month-event-chip"
                :class="{ 'is-synced': isSourced(ev) }"
                :title="eventTooltip(ev)"
                @click.stop="isSourced(ev) ? openSyncedPopup(ev, { x: $event.clientX, y: $event.clientY }) : openEditModal(ev)"
              >
                <span class="month-event-time">{{ formatEventTime(ev.start_at) }}</span>
                {{ ev.title }}
                <RefreshCw v-if="isRecurring(ev)" :size="8" class="month-event-recur-icon" />
                <Cloud v-else-if="isSourced(ev)" :size="8" class="month-event-recur-icon" />
              </div>
            </div>
          </div>
        </template>
      </div>
    </template>

    <!-- Meeting modal (locally-created events) -->
    <MeetingModal
      v-if="showModal"
      :event="modalEvent"
      :default-start="modalDefaultStart"
      :default-end="modalDefaultEnd"
      @saved="onModalSaved"
      @deleted="onModalDeleted"
      @cancel="showModal = false"
      @open-note="emit('open-note', $event)"
    />

    <!-- Synced event info popup (read-only) -->
    <SyncedEventPopup
      v-if="syncedPopupEvent"
      :event="syncedPopupEvent"
      :position="syncedPopupPos"
      @close="syncedPopupEvent = null"
      @open-note="emit('open-note', $event); syncedPopupEvent = null"
      @note-linked="onSyncedNoteLinked"
      @note-unlinked="onSyncedNoteUnlinked"
    />
  </div>
</template>

<style scoped>
.calendar-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  align-self: stretch;   /* fill viewport height regardless of parent align-items */
  overflow: hidden;
  background: var(--color-bg);
}

/* ── Toolbar ─────────────────────────────────────────────────────────────── */

.cal-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  background: var(--color-surface);
}

.cal-nav {
  display: flex;
  align-items: center;
  gap: 4px;
}

.btn-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
}

.btn-nav:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.btn-today {
  padding: 5px 12px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.btn-today:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.cal-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  flex: 1;
}

.cal-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.view-switcher {
  display: flex;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  overflow: hidden;
}

.view-btn {
  padding: 5px 11px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
}

.view-btn:last-child {
  border-right: none;
}

.view-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.view-btn.active {
  background: var(--color-accent);
  color: #fff;
  font-weight: 500;
}

.btn-new-meeting {
  display: flex;
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

.btn-new-meeting:hover {
  opacity: 0.9;
}

/* ── Column headers ──────────────────────────────────────────────────────── */

.col-headers {
  display: grid;
  grid-template-columns: 52px repeat(var(--cols), 1fr);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  background: var(--color-surface);
}

.time-gutter-header {
  border-right: 1px solid var(--color-border);
}

.col-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 6px 0;
  border-right: 1px solid var(--color-border);
  gap: 2px;
}

.col-header:last-child {
  border-right: none;
}

.col-day-name {
  font-size: 11px;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.col-day-num {
  font-size: 18px;
  font-weight: 300;
  color: var(--color-text);
  line-height: 1;
}

.day-today {
  width: 32px;
  height: 32px;
  background: var(--color-accent);
  color: #fff !important;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 14px;
}

/* ── Time grid ───────────────────────────────────────────────────────────── */

.time-grid-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

.time-grid {
  display: grid;
  grid-template-columns: 52px repeat(var(--cols), 1fr);
  /* height is determined by hour slot content, not the container */
}

.time-gutter {
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  flex-shrink: 0;
}

.time-label {
  height: var(--hour-height);
  display: flex;
  align-items: flex-start;
  justify-content: flex-end;
  padding: 3px 8px 0 0;
  font-size: 10px;
  color: var(--color-text-muted);
  box-sizing: border-box;
  flex-shrink: 0;
}

.day-col {
  position: relative;
  border-right: 1px solid var(--color-border);
}

.day-col:last-child {
  border-right: none;
}

.hour-slot {
  height: var(--hour-height);
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  box-sizing: border-box;
}

.hour-slot:hover {
  background: rgba(91, 141, 239, 0.04);
}

/* Events */

.event-block {
  position: absolute;
  left: 2px;
  right: 2px;
  background: rgba(91, 141, 239, 0.15);
  border: 1px solid rgba(91, 141, 239, 0.4);
  border-left: 3px solid var(--color-accent);
  border-radius: 4px;
  padding: 3px 6px 6px;
  overflow: hidden;
  cursor: grab;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.event-block:hover {
  background: rgba(91, 141, 239, 0.25);
}

.event-block:active {
  cursor: grabbing;
}

/* Synced (read-only) events — teal tint */
.event-block.is-synced {
  background: rgba(74, 222, 128, 0.1);
  border-color: rgba(74, 222, 128, 0.35);
  border-left-color: #4ade80;
  cursor: pointer;
}

.event-block.is-synced:hover {
  background: rgba(74, 222, 128, 0.18);
}

.event-synced-icon {
  flex-shrink: 0;
  color: #4ade80;
  opacity: 0.8;
  margin-top: 2px;
}

.drag-preview {
  pointer-events: none;
  opacity: 0.5;
  border-style: dashed;
  cursor: default;
}

.move-ghost {
  pointer-events: none;
  opacity: 0.75;
  border-style: dashed;
  cursor: grabbing;
  z-index: 2;
}

.event-resize-handle {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 6px;
  cursor: ns-resize;
  display: flex;
  align-items: center;
  justify-content: center;
}

.event-resize-handle::after {
  content: '';
  display: block;
  width: 18px;
  height: 2px;
  background: rgba(255, 255, 255, 0.45);
  border-radius: 1px;
}

.event-header-row {
  display: flex;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
}

.event-recur-icon {
  flex-shrink: 0;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 2px;
}

.event-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.3;
  flex: 1;
  min-width: 0;
}

.event-time {
  font-size: 10px;
  color: var(--color-text-muted);
  line-height: 1;
}

/* ── Month grid ──────────────────────────────────────────────────────────── */

.month-grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  grid-auto-rows: minmax(90px, 1fr);
  overflow-y: auto;
  border-top: 1px solid var(--color-border);
}

.month-day-name {
  padding: 6px 0;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  grid-row: 1;
}

.month-day-cell {
  border-right: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  padding: 6px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-height: 90px;
}

.month-day-cell:nth-child(7n) {
  border-right: none;
}

.month-day-cell:hover {
  background: rgba(255, 255, 255, 0.02);
}

.month-day-today {
  background: rgba(91, 141, 239, 0.04);
}

.month-day-other .month-day-num {
  opacity: 0.35;
}

.month-day-num {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  flex-shrink: 0;
}

.month-day-today .month-day-num {
  background: var(--color-accent);
  color: #fff;
}

.month-events {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}

.month-event-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(91, 141, 239, 0.12);
  border: 1px solid rgba(91, 141, 239, 0.25);
  border-radius: 3px;
  padding: 2px 6px;
  font-size: 11px;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  line-height: 1.4;
}

.month-event-chip:hover {
  background: rgba(91, 141, 239, 0.22);
}

.month-event-chip.is-synced {
  background: rgba(74, 222, 128, 0.1);
  border-color: rgba(74, 222, 128, 0.3);
}

.month-event-chip.is-synced:hover {
  background: rgba(74, 222, 128, 0.18);
}

.month-event-time {
  color: var(--color-accent);
  font-size: 10px;
  flex-shrink: 0;
  font-weight: 500;
}

.month-event-recur-icon {
  flex-shrink: 0;
  color: var(--color-accent);
  opacity: 0.65;
  margin-left: auto;
}
</style>
