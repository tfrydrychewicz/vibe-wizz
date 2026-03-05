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
        <template v-for="session in sessions" :key="session.filePath">
          <div
            v-if="processingPaths.has(session.filePath)"
            class="recovery-btn recovery-btn-processing"
            :title="`Processing ${formatDate(session.startedAt)}…`"
          >
            <AudioWaveLoader :bar-count="5" size="xs" color="#fff" />
            <span>Processing…</span>
          </div>
          <button
            v-else
            class="recovery-btn recovery-btn-process"
            @click="$emit('retry', session)"
          >
            Process {{ formatDate(session.startedAt) }}
          </button>
        </template>
        <button class="recovery-btn recovery-btn-discard" @click="onDiscardAll">
          Discard all
        </button>
      </div>
    </div>
    <div v-if="error" class="recovery-error">
      <span class="recovery-error-icon">⚠️</span>
      <span class="recovery-error-text">{{ error }}</span>
      <button class="recovery-error-dismiss" @click="$emit('dismiss-error')">✕</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import AudioWaveLoader from './AudioWaveLoader.vue'

export interface RecoveryMeta {
  noteId: string
  startedAt: string
  format: 'pcm' | 'webm'
  filePath: string
  metaPath: string
}

const props = defineProps<{
  sessions: RecoveryMeta[]
  processingPaths: Set<string>
  error?: string | null
}>()

const emit = defineEmits<{
  retry: [session: RecoveryMeta]
  discard: [session: RecoveryMeta]
  'dismiss-error': []
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

.recovery-btn-processing {
  background: var(--color-accent, #4a9eff);
  color: #fff;
  border-color: var(--color-accent, #4a9eff);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  opacity: 0.75;
  cursor: default;
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

.recovery-error {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: 6px;
  padding: 6px 10px;
  background: rgba(220, 80, 60, 0.12);
  border: 1px solid rgba(220, 80, 60, 0.3);
  border-radius: 6px;
  font-size: 12px;
  color: #f87171;
  line-height: 1.4;
}

.recovery-error-icon {
  flex-shrink: 0;
  font-size: 13px;
  margin-top: 1px;
}

.recovery-error-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}

.recovery-error-dismiss {
  flex-shrink: 0;
  background: none;
  border: none;
  color: #f87171;
  opacity: 0.6;
  cursor: pointer;
  padding: 0 2px;
  font-size: 11px;
  line-height: 1;
  margin-top: 1px;
}

.recovery-error-dismiss:hover {
  opacity: 1;
}
</style>
