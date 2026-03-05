<template>
  <div class="recovery-banner">
    <div class="recovery-banner-inner">
      <div class="recovery-banner-text">
        <span class="recovery-icon">🎙️</span>
        <span>
          {{ sessions.length === 1 ? '1 recording' : `${sessions.length} recordings` }}
          from a previous session
          {{ sessions.length === 1 ? 'is' : 'are' }} pending transcription.
        </span>
      </div>
      <div class="recovery-actions">
        <button
          v-for="session in sessions"
          :key="session.filePath"
          class="recovery-btn recovery-btn-process"
          @click="$emit('retry', session)"
        >
          Process {{ formatDate(session.startedAt) }}
        </button>
        <button class="recovery-btn recovery-btn-discard" @click="onDiscardAll">
          Discard all
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
export interface RecoveryMeta {
  noteId: string
  startedAt: string
  format: 'pcm' | 'webm'
  filePath: string
  metaPath: string
}

const props = defineProps<{
  sessions: RecoveryMeta[]
}>()

const emit = defineEmits<{
  retry: [session: RecoveryMeta]
  discard: [session: RecoveryMeta]
}>()

function onDiscardAll() {
  for (const session of props.sessions) {
    emit('discard', session)
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso.slice(0, 16)
  }
}
</script>

<style scoped>
.recovery-banner {
  background: var(--color-surface-elevated, #2a2a2a);
  border-bottom: 1px solid var(--color-border, #3a3a3a);
  padding: 8px 16px;
  flex-shrink: 0;
}

.recovery-banner-inner {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.recovery-banner-text {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-secondary, #aaa);
  flex: 1;
  min-width: 0;
}

.recovery-icon {
  font-size: 14px;
  flex-shrink: 0;
}

.recovery-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.recovery-btn {
  padding: 4px 10px;
  border-radius: 5px;
  border: 1px solid transparent;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.15s;
}

.recovery-btn-process {
  background: var(--color-accent, #4a9eff);
  color: #fff;
  border-color: var(--color-accent, #4a9eff);
}

.recovery-btn-process:hover {
  opacity: 0.85;
}

.recovery-btn-discard {
  background: transparent;
  color: var(--color-text-tertiary, #777);
  border-color: var(--color-border, #3a3a3a);
}

.recovery-btn-discard:hover {
  color: var(--color-text-secondary, #aaa);
  border-color: var(--color-text-tertiary, #777);
}
</style>
