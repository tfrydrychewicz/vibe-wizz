<script setup lang="ts">
import { ref, nextTick, onMounted } from 'vue'
import { Sparkles, X, FileText, Paperclip } from 'lucide-vue-next'
import { useInputMention } from '../composables/useInputMention'
import { useInputNoteLink } from '../composables/useInputNoteLink'
import { useFileAttachment, SUPPORTED_ALL_ACCEPT, type AttachedFile } from '../composables/useFileAttachment'
import AttachmentBar from './AttachmentBar.vue'
import { MODELS, DEFAULT_CHAT_MODEL, type ChatModelId } from '../constants/models'

export interface AIPromptSubmit {
  prompt: string
  mentionedEntityIds: string[]
  mentionedNoteIds: string[]
  images: { dataUrl: string; mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' }[]
  files: { name: string; content: string; mimeType: AttachedFile['mimeType'] }[]
  model: ChatModelId
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

const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const promptText = ref('')
const selectedModel = ref<ChatModelId>(DEFAULT_CHAT_MODEL)

// ── Composables ────────────────────────────────────────────────────────────────
const {
  attachedImages,
  attachedFiles,
  isDragOver,
  dropError,
  removeImage,
  removeFile,
  onPaste,
  onDrop,
  onFileInputChange,
} = useFileAttachment()

const mention = useInputMention(textarea, promptText)
const noteLink = useInputNoteLink(textarea, promptText)

onMounted(() => {
  nextTick(() => textarea.value?.focus())
})

function openFilePicker(): void {
  fileInput.value?.click()
}

// ── Keyboard + input ───────────────────────────────────────────────────────────

function onInput(): void {
  const hadMention = mention.updateState(noteLink.close)
  if (!hadMention) noteLink.updateState(mention.close)
}

function onKeydown(e: KeyboardEvent): void {
  if (mention.handleKeydown(e)) return
  if (noteLink.handleKeydown(e)) return

  if (e.key === 'Escape') {
    emit('close')
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    if (!props.loading && promptText.value.trim()) {
      doSubmit()
    }
  }
}

function doSubmit(): void {
  emit('submit', {
    prompt: promptText.value.trim(),
    mentionedEntityIds: mention.mentionedEntities.value.map((e) => e.id),
    mentionedNoteIds: noteLink.mentionedNotes.value.map((n) => n.id),
    images: attachedImages.value.map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType })),
    files: attachedFiles.value.map(({ name, content, mimeType }) => ({ name, content, mimeType })),
    model: selectedModel.value,
  })
}

const hasContext = () =>
  mention.mentionedEntities.value.length > 0 ||
  noteLink.mentionedNotes.value.length > 0 ||
  attachedImages.value.length > 0 ||
  attachedFiles.value.length > 0
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

      <!-- Context bar: entity/note chips + file/image attachments -->
      <div v-if="hasContext()" class="ai-modal-context">
        <span
          v-for="entity in mention.mentionedEntities.value"
          :key="entity.id"
          class="ai-modal-chip ai-modal-chip--entity"
        >
          @{{ entity.name }}
          <span class="ai-modal-chip-type">{{ entity.type_name }}</span>
          <button class="ai-modal-chip-remove" @mousedown.prevent @click="mention.removeEntity(entity.id)">
            <X :size="10" />
          </button>
        </span>
        <span
          v-for="note in noteLink.mentionedNotes.value"
          :key="note.id"
          class="ai-modal-chip ai-modal-chip--note"
        >
          <FileText :size="11" />
          {{ note.title }}
          <button class="ai-modal-chip-remove" @mousedown.prevent @click="noteLink.removeNote(note.id)">
            <X :size="10" />
          </button>
        </span>
        <AttachmentBar
          :attached-images="attachedImages"
          :attached-files="attachedFiles"
          @remove-image="removeImage"
          @remove-file="removeFile"
        />
      </div>

      <!-- Textarea with floating dropdowns -->
      <div class="ai-modal-input-wrap">
        <!-- Entity mention dropdown -->
        <div v-if="mention.mentionActive.value && mention.mentionResults.value.length > 0" class="ai-modal-picker">
          <button
            v-for="(entity, i) in mention.mentionResults.value"
            :key="entity.id"
            class="ai-modal-picker-option"
            :class="{ 'ai-modal-picker-option--active': i === mention.mentionIndex.value }"
            @mousedown.prevent
            @click="mention.pick(entity)"
          >
            <span class="ai-modal-picker-name">@{{ entity.name }}</span>
            <span class="ai-modal-picker-badge">{{ entity.type_name }}</span>
          </button>
        </div>

        <!-- Note link dropdown -->
        <div v-if="noteLink.noteLinkActive.value && noteLink.noteLinkResults.value.length > 0" class="ai-modal-picker">
          <button
            v-for="(note, i) in noteLink.noteLinkResults.value"
            :key="note.id"
            class="ai-modal-picker-option"
            :class="{ 'ai-modal-picker-option--active': i === noteLink.noteLinkIndex.value }"
            @mousedown.prevent
            @click="noteLink.pick(note)"
          >
            <FileText :size="13" class="ai-modal-picker-note-icon" />
            <span class="ai-modal-picker-name">{{ note.title }}</span>
          </button>
        </div>

        <textarea
          ref="textarea"
          v-model="promptText"
          class="ai-modal-textarea"
          :placeholder="mode === 'replace'
            ? 'Describe how to rewrite the selection… (@entity, [[note, paste or drag file)'
            : 'Describe what to write here… (@entity, [[note, paste or drag file)'"
          :disabled="loading"
          rows="3"
          @keydown="onKeydown"
          @input="onInput"
          @paste="onPaste"
          @dragover.prevent.stop="isDragOver = true"
          @dragleave.stop="isDragOver = false"
          @drop.prevent.stop="onDrop"
        />
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

      <div v-if="dropError" class="ai-modal-error">{{ dropError }}</div>
      <div v-if="errorMessage" class="ai-modal-error">{{ errorMessage }}</div>
      <div class="ai-modal-footer">
        <div class="ai-modal-footer-left">
          <button
            class="ai-modal-attach"
            title="Attach file (image, PDF, TXT, CSV, MD)"
            :disabled="loading"
            @mousedown.prevent
            @click="openFilePicker"
          >
            <Paperclip :size="14" />
          </button>
          <span class="ai-modal-hint">Enter ↵ · Shift+Enter newline · Esc cancel</span>
        </div>
        <select v-model="selectedModel" class="ai-modal-model-select" :disabled="loading" title="Claude model">
          <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
        </select>
        <button
          class="ai-modal-submit"
          :disabled="loading || (!promptText.trim() && attachedImages.length === 0 && attachedFiles.length === 0)"
          @mousedown.prevent
          @click="doSubmit"
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

/* ── Context chips ─────────────────────────────────────────────────────────── */

.ai-modal-context {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.ai-modal-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  border-radius: 5px;
  padding: 3px 7px 3px 8px;
  line-height: 1;
}

.ai-modal-chip--entity {
  background: rgba(91, 141, 239, 0.12);
  color: var(--color-accent, #5b8def);
  border: 1px solid rgba(91, 141, 239, 0.25);
}

.ai-modal-chip--note {
  background: rgba(34, 197, 94, 0.1);
  color: #16a34a;
  border: 1px solid rgba(34, 197, 94, 0.25);
}

.ai-modal-chip-type {
  font-size: 10px;
  opacity: 0.7;
  border-left: 1px solid currentColor;
  padding-left: 5px;
}

.ai-modal-chip-remove {
  display: inline-flex;
  align-items: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0 0 0 2px;
  color: inherit;
  opacity: 0.6;
  line-height: 1;
}

.ai-modal-chip-remove:hover {
  opacity: 1;
}

/* ── Input area ────────────────────────────────────────────────────────────── */

.ai-modal-input-wrap {
  position: relative;
}

.ai-modal-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  overflow-y: auto;
  max-height: 200px;
  z-index: 10;
}

.ai-modal-picker-option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  text-align: left;
  padding: 7px 10px;
  cursor: pointer;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
}

.ai-modal-picker-option:hover,
.ai-modal-picker-option--active {
  background: var(--color-hover);
}

.ai-modal-picker-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ai-modal-picker-badge {
  font-size: 11px;
  color: var(--color-text-muted);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 1px 5px;
  white-space: nowrap;
}

.ai-modal-picker-note-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
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

/* ── Footer ────────────────────────────────────────────────────────────────── */

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

.ai-modal-file-input {
  display: none;
}

.ai-modal-footer-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.ai-modal-attach {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px 6px;
  flex-shrink: 0;
}

.ai-modal-attach:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-accent);
}

.ai-modal-attach:disabled {
  opacity: 0.4;
  cursor: default;
}

.ai-modal-hint {
  font-size: 11px;
  color: var(--color-text-muted);
}

.ai-modal-model-select {
  appearance: none;
  background: var(--color-hover);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  padding: 2px 6px;
  height: 22px;
  cursor: pointer;
  outline: none;
  flex-shrink: 0;
}

.ai-modal-model-select:hover:not(:disabled),
.ai-modal-model-select:focus:not(:disabled) {
  border-color: var(--color-accent);
  color: var(--color-text);
}

.ai-modal-model-select:disabled {
  opacity: 0.4;
  cursor: default;
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
