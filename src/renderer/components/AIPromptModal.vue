<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { Sparkles } from 'lucide-vue-next'

const props = defineProps<{
  loading: boolean
  mode: 'insert' | 'replace'
  errorMessage?: string
}>()

const emit = defineEmits<{
  submit: [prompt: string]
  close: []
}>()

const textarea = ref<HTMLTextAreaElement | null>(null)
const promptText = ref('')

onMounted(() => {
  nextTick(() => textarea.value?.focus())
})

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (!props.loading && promptText.value.trim()) {
      emit('submit', promptText.value.trim())
    }
  }
}
</script>

<template>
  <div class="ai-modal-overlay" @mousedown="emit('close')">
    <div class="ai-modal-popup" @mousedown.stop>
      <div class="ai-modal-header">
        <Sparkles :size="14" class="ai-modal-icon" />
        <span class="ai-modal-title">
          {{ mode === 'replace' ? 'AI: Replace selection' : 'AI: Insert content' }}
        </span>
      </div>
      <textarea
        ref="textarea"
        v-model="promptText"
        class="ai-modal-textarea"
        :placeholder="mode === 'replace'
          ? 'Describe how to rewrite the selection…'
          : 'Describe what to write here…'"
        :disabled="loading"
        rows="3"
        @keydown="onKeydown"
      />
      <div v-if="errorMessage" class="ai-modal-error">{{ errorMessage }}</div>
      <div class="ai-modal-footer">
        <span class="ai-modal-hint">Enter to submit · Shift+Enter for newline · Esc to cancel</span>
        <button
          class="ai-modal-submit"
          :disabled="loading || !promptText.trim()"
          @mousedown.prevent
          @click="emit('submit', promptText.trim())"
        >
          <span v-if="loading" class="ai-modal-spinner" />
          <span v-else>Generate</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.ai-modal-popup {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 440px;
  max-width: calc(100vw - 48px);
}

.ai-modal-header {
  display: flex;
  align-items: center;
  gap: 7px;
}

.ai-modal-icon {
  color: var(--color-accent);
}

.ai-modal-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ai-modal-textarea {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 8px 10px;
  resize: vertical;
  outline: none;
  width: 100%;
  box-sizing: border-box;
  line-height: 1.5;
}

.ai-modal-textarea:focus {
  border-color: var(--color-accent);
}

.ai-modal-textarea:disabled {
  opacity: 0.5;
}

.ai-modal-error {
  font-size: 12px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 5px;
  padding: 6px 10px;
}

.ai-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.ai-modal-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.ai-modal-submit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--color-accent, #5b8def);
  color: #fff;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 500;
  padding: 5px 14px;
  cursor: pointer;
  min-width: 80px;
  justify-content: center;
}

.ai-modal-submit:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai-modal-submit:not(:disabled):hover {
  opacity: 0.88;
}

.ai-modal-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: ai-spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes ai-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
