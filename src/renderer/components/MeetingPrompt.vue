<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { Mic, X } from 'lucide-vue-next'

const deviceName = ref<string | null>(null)
const visible = ref(false)

function skip(): void {
  visible.value = false
  window.api.send('meeting-prompt:skip')
}

function transcribe(): void {
  visible.value = false
  window.api.send('meeting-prompt:transcribe')
}

async function alwaysTranscribe(): Promise<void> {
  visible.value = false
  window.api.send('meeting-prompt:always-transcribe')
}

let unsubActive: (() => void) | null = null
let unsubInactive: (() => void) | null = null

onMounted(() => {
  unsubActive = window.api.on('mic:active', (data: unknown) => {
    const event = data as { deviceName: string | null }
    deviceName.value = event.deviceName
    visible.value = true
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
