<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Mic, X, ChevronDown } from 'lucide-vue-next'
import type { CalendarEvent } from './MeetingModal.vue'

const deviceName = ref<string | null>(null)
const visible = ref(false)
const todayEvents = ref<CalendarEvent[]>([])
// 'new' = create new meeting; otherwise stringified event id
const selectedEventId = ref<string>('new')

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const h = d.getHours()
  const m = String(d.getMinutes()).padStart(2, '0')
  const ampm = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 || 12
  return `${h12}:${m}${ampm}`
}

async function loadTodayEvents(): Promise<void> {
  const now = new Date()
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0)
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0)

  const events = (await window.api.invoke('calendar-events:list', {
    start_at: startOfDay.toISOString(),
    end_at: endOfDay.toISOString(),
  })) as CalendarEvent[]

  todayEvents.value = events

  // Auto-select a meeting that is happening now or starts within 10 minutes
  const nowMs = now.getTime()
  const tenMinMs = nowMs + 10 * 60 * 1000
  const match = events.find(e => {
    const start = new Date(e.start_at).getTime()
    const end = new Date(e.end_at).getTime()
    return (nowMs >= start && nowMs <= end) || (start >= nowMs && start <= tenMinMs)
  })
  selectedEventId.value = match ? String(match.id) : 'new'
}

function skip(): void {
  visible.value = false
  window.api.send('meeting-prompt:skip')
}

async function doTranscribe(always: boolean): Promise<void> {
  visible.value = false

  let eventId: number
  if (selectedEventId.value === 'new') {
    const now = new Date()
    const end = new Date(now.getTime() + 60 * 60 * 1000)
    const created = (await window.api.invoke('calendar-events:create', {
      title: 'New Meeting',
      start_at: now.toISOString(),
      end_at: end.toISOString(),
    })) as { id: number }
    eventId = created.id
  } else {
    eventId = parseInt(selectedEventId.value, 10)
  }

  if (always) {
    window.api.send('meeting-prompt:always-transcribe', { eventId })
  } else {
    window.api.send('meeting-prompt:transcribe', { eventId })
  }
}

function transcribe(): void {
  void doTranscribe(false)
}

function alwaysTranscribe(): void {
  void doTranscribe(true)
}

let unsubActive: (() => void) | null = null
let unsubInactive: (() => void) | null = null

onMounted(() => {
  unsubActive = window.api.on('mic:active', (data: unknown) => {
    const event = data as { deviceName: string | null }
    void window.api.invoke('transcription:status').then((status: unknown) => {
      const s = status as { isTranscribing: boolean }
      if (s.isTranscribing) return
      deviceName.value = event.deviceName
      visible.value = true
      void loadTodayEvents()
    })
  })
  unsubInactive = window.api.on('mic:inactive', () => {
    visible.value = false
  })
})

onBeforeUnmount(() => {
  unsubActive?.()
  unsubInactive?.()
})
</script>

<template>
  <Transition name="prompt">
    <div v-if="visible" class="card">
      <div class="card-header">
        <span class="card-icon"><Mic :size="14" /></span>
        <span class="card-title">Meeting detected</span>
        <button class="card-close" title="Skip" @click="skip">
          <X :size="13" />
        </button>
      </div>
      <p class="card-device">{{ deviceName ?? 'Microphone active' }}</p>

      <!-- Meeting selector -->
      <div class="meeting-select-wrap">
        <select v-model="selectedEventId" class="meeting-select">
          <option
            v-for="ev in todayEvents"
            :key="ev.id"
            :value="String(ev.id)"
          >
            {{ ev.title }} ({{ formatTime(ev.start_at) }}–{{ formatTime(ev.end_at) }})
          </option>
          <option value="new">+ New Meeting</option>
        </select>
        <ChevronDown class="select-arrow" :size="12" />
      </div>

      <div class="card-actions">
        <button class="btn btn-primary" @click="transcribe">Transcribe</button>
        <button class="btn btn-secondary" @click="alwaysTranscribe">Always transcribe</button>
        <button class="btn btn-ghost" @click="skip">Skip</button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  -webkit-app-region: drag;
  height: 100%;
  box-sizing: border-box;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  -webkit-app-region: drag;
}

.card-icon {
  color: #ef4444;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.card-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.card-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--color-text-muted);
  cursor: pointer;
  -webkit-app-region: no-drag;
}

.card-close:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.card-device {
  font-size: 11px;
  color: var(--color-text-muted);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Meeting selector */

.meeting-select-wrap {
  position: relative;
  display: flex;
  align-items: center;
  -webkit-app-region: no-drag;
}

.meeting-select {
  width: 100%;
  appearance: none;
  -webkit-appearance: none;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 5px 28px 5px 9px;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  outline: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.meeting-select:focus {
  border-color: var(--color-accent);
}

.select-arrow {
  position: absolute;
  right: 8px;
  color: var(--color-text-muted);
  pointer-events: none;
}

.card-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  -webkit-app-region: no-drag;
}

.btn {
  font-size: 12px;
  font-weight: 500;
  padding: 5px 10px;
  border-radius: 5px;
  border: none;
  cursor: pointer;
  transition: opacity 0.1s;
}

.btn:hover {
  opacity: 0.85;
}

.btn-primary {
  background: #3b82f6;
  color: #fff;
}

.btn-secondary {
  background: var(--color-hover);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.btn-ghost {
  background: transparent;
  color: var(--color-text-muted);
}

/* Slide-down + fade */
.prompt-enter-active,
.prompt-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.prompt-enter-from,
.prompt-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
