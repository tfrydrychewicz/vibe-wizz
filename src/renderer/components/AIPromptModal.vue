<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue'
import { Sparkles, Paperclip } from 'lucide-vue-next'
import { useFileAttachment, SUPPORTED_ALL_ACCEPT, type AttachedFile } from '../composables/useFileAttachment'
import type { NoteSelectionAttachment } from '../types/noteSelection'
import AttachmentBar from './AttachmentBar.vue'
import RichTextInput from './RichTextInput.vue'
import ModelSelect from './ModelSelect.vue'
import AgentStepProgress from './AgentStepProgress.vue'
import type { StepProgress } from './AgentStepProgress.vue'
import type { RichInputContent } from './RichTextInput.vue'

export interface AIPromptSubmit {
  prompt: string
  mentionedEntityIds: string[]
  mentionedNoteIds: string[]
  images: { dataUrl: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }[]
  files: { name: string; content: string; mimeType: AttachedFile['mimeType'] }[]
  noteSelections: NoteSelectionAttachment[]
  model: string
}

const props = defineProps<{
  loading: boolean
  mode: 'insert' | 'replace'
  errorMessage?: string
}>()

const emit = defineEmits<{
  submit: [payload: AIPromptSubmit]
  close: []
}>()

const richInput = ref<InstanceType<typeof RichTextInput> | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const selectedModel = ref('')
const chatModels = ref<{ id: string; label: string }[]>([])
const hasContent = ref(false)

// ── File attachment ────────────────────────────────────────────────────────────
const {
  attachedImages,
  attachedFiles,
  isDragOver,
  dropError,
  removeImage,
  removeFile,
  onPaste: onFilePaste,
  onDrop,
  onFileInputChange,
} = useFileAttachment()

// ── Agent step progress ──────────────────────────────────────────────────────
const agentSteps = ref<StepProgress[]>([])
const agentPhase = ref<'idle' | 'classifying' | 'planning' | 'executing' | 'done'>('idle')

let unsubPhase: (() => void) | null = null
let unsubProgress: (() => void) | null = null

onMounted(async () => {
  nextTick(() => richInput.value?.focus())

  unsubPhase = window.api.on('inline-agent:phase', (data: unknown) => {
    const { phase } = data as { phase: typeof agentPhase.value }
    agentPhase.value = phase
    if (phase === 'classifying' || phase === 'planning') {
      agentSteps.value = []
    }
  })
  unsubProgress = window.api.on('inline-agent:step-progress', (data: unknown) => {
    const step = data as StepProgress
    const idx = agentSteps.value.findIndex((s) => s.stepId === step.stepId)
    if (idx >= 0) {
      agentSteps.value[idx] = step
    } else {
      agentSteps.value.push(step)
    }
  })

  try {
    interface ProviderRow { id: string; label: string; models: { id: string; label: string; capabilities: string[]; enabled: boolean }[] }
    const providers = await window.api.invoke('ai-providers:list') as ProviderRow[]
    const models: { id: string; label: string }[] = []
    for (const p of providers) {
      for (const m of p.models) {
        if (m.enabled && m.capabilities.includes('chat')) {
          models.push({ id: m.id, label: `${m.label} (${p.label})` })
        }
      }
    }
    chatModels.value = models
  } catch { /* leave empty */ }
})

onUnmounted(() => {
  unsubPhase?.()
  unsubProgress?.()
})

function openFilePicker(): void {
  fileInput.value?.click()
}

function onContentChange(): void {
  hasContent.value = !(richInput.value?.isEmpty() ?? true)
}

function doSubmit(): void {
  if (!richInput.value) return
  const { text, mentionedEntityIds, mentionedNoteIds, selections }: RichInputContent = richInput.value.getContent()
  if (!text && selections.length === 0 && mentionedEntityIds.length === 0 && mentionedNoteIds.length === 0
    && attachedImages.value.length === 0 && attachedFiles.value.length === 0) return

  emit('submit', {
    prompt: text,
    mentionedEntityIds,
    mentionedNoteIds,
    images: attachedImages.value.map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType })),
    files: attachedFiles.value.map(({ name, content, mimeType }) => ({ name, content, mimeType })),
    noteSelections: selections.map((s) => ({ ...s })),
    model: selectedModel.value,
  })
}
</script>

<template>
  <div class="ai-modal-overlay" @mousedown="emit('close')" @dragover.prevent @drop.prevent>
    <div
      class="ai-modal-popup"
      :class="{ 'ai-modal-popup--drag': isDragOver }"
      @mousedown.stop
      @dragover.prevent="isDragOver = true"
      @dragleave="isDragOver = false"
      @drop.prevent="onDrop"
    >
      <div class="ai-modal-header">
        <Sparkles :size="14" class="ai-modal-icon" />
        <span class="ai-modal-title">
          {{ mode === 'replace' ? 'AI: Replace selection' : 'AI: Insert content' }}
        </span>
      </div>

      <!-- Unified input box (Cursor-style): attachments + rich text + toolbar -->
      <div
        class="ai-modal-input-wrap"
        @dragover.prevent="isDragOver = true"
        @dragleave="isDragOver = false"
        @drop.prevent="onDrop"
      >
        <!-- File/image attachments (inside box, above text) -->
        <div v-if="attachedImages.length > 0 || attachedFiles.length > 0" class="ai-modal-files">
          <AttachmentBar
            :attached-images="attachedImages"
            :attached-files="attachedFiles"
            @remove-image="removeImage"
            @remove-file="removeFile"
          />
        </div>

        <!-- Rich text input (borderless — box provides the border) -->
        <RichTextInput
          ref="richInput"
          :placeholder="mode === 'replace'
            ? 'Describe how to rewrite the selection…'
            : 'Describe what to write here…'"
          :disabled="loading"
          @submit="doSubmit"
          @escape="emit('close')"
          @paste="onFilePaste"
          @change="onContentChange"
        />

        <!-- Bottom toolbar -->
        <div class="ai-modal-toolbar">
          <ModelSelect
            v-if="chatModels.length > 0"
            v-model="selectedModel"
            :models="chatModels"
            :disabled="loading"
          />
          <div class="ai-modal-toolbar-spacer" />
          <button
            class="ai-modal-toolbar-btn"
            title="Attach file (image, PDF, TXT, CSV, MD)"
            :disabled="loading"
            @mousedown.prevent
            @click="openFilePicker"
          >
            <Paperclip :size="14" />
          </button>
          <button
            class="ai-modal-submit"
            :disabled="loading || (!hasContent && attachedImages.length === 0 && attachedFiles.length === 0)"
            @mousedown.prevent
            @click="doSubmit"
          >
            <span v-if="loading" class="ai-modal-spinner" />
            <span v-else>Generate</span>
          </button>
        </div>
      </div>

      <!-- Hidden file input -->
      <input
        ref="fileInput"
        type="file"
        :accept="SUPPORTED_ALL_ACCEPT"
        multiple
        class="ai-modal-file-input"
        @change="onFileInputChange"
      />

      <!-- Agent step progress (visible during multi-step inline AI) -->
      <div v-if="loading && (agentPhase === 'classifying' || agentPhase === 'planning')" class="ai-modal-phase">
        <svg class="ai-modal-phase-spinner" width="12" height="12" viewBox="0 0 16 16">
          <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2"/>
          <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span v-if="agentPhase === 'classifying'">Analyzing prompt…</span>
        <span v-else>Planning steps…</span>
      </div>
      <AgentStepProgress
        v-if="loading && agentSteps.length > 0"
        :steps="agentSteps"
        :collapsed="false"
      />

      <div v-if="dropError" class="ai-modal-error">{{ dropError }}</div>
      <div v-if="errorMessage" class="ai-modal-error">{{ errorMessage }}</div>
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
  width: 480px;
  max-width: calc(100vw - 48px);
}

.ai-modal-popup--drag {
  border-color: var(--color-accent);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.55), 0 0 0 2px var(--color-accent, #5b8def);
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

/* ── Input area (unified box, Cursor-style) ────────────────────────────────── */

.ai-modal-input-wrap {
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  transition: border-color 0.15s;
  /* Override RichTextInput so the box provides the border */
  --rich-input-border: none;
  --rich-input-bg: transparent;
  --rich-input-radius: 0;
}

.ai-modal-input-wrap:focus-within {
  border-color: var(--color-accent);
}

.ai-modal-files {
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--color-border);
}

/* ── Bottom toolbar ─────────────────────────────────────────────────────────── */

.ai-modal-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
}

.ai-modal-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s, color 0.1s;
}

.ai-modal-toolbar-btn:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-text);
}

.ai-modal-toolbar-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.ai-modal-toolbar-spacer {
  flex: 1;
}



.ai-modal-submit {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--color-accent, #5b8def);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 4px 12px;
  height: 28px;
  cursor: pointer;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.ai-modal-submit:disabled {
  opacity: 0.5;
  cursor: default;
}

.ai-modal-submit:not(:disabled):hover {
  opacity: 0.88;
}

/* ── Errors ─────────────────────────────────────────────────────────────────── */

.ai-modal-error {
  font-size: 12px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 5px;
  padding: 6px 10px;
}

.ai-modal-phase {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.ai-modal-phase-spinner {
  animation: ai-spin 0.7s linear infinite;
  flex-shrink: 0;
}

.ai-modal-file-input {
  display: none;
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
