<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from 'vue'
import { marked } from 'marked'
import { X, Trash2, Send, MessageSquare, CalendarPlus, CalendarCheck, CalendarX, ListPlus, CheckSquare, SquareMinus, FilePlus, Paperclip, FileText } from 'lucide-vue-next'
import { messages, isLoading, clearMessages, type ChatMessage, type ExecutedAction, type AttachedImage, type AttachedFile } from '../stores/chatStore'
import type { OpenMode } from '../stores/tabStore'
import { useInputMention } from '../composables/useInputMention'
import { useInputNoteLink } from '../composables/useInputNoteLink'
import { useFileAttachment, SUPPORTED_ALL_ACCEPT } from '../composables/useFileAttachment'
import AttachmentBar from './AttachmentBar.vue'

const emit = defineEmits<{
  close: []
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
  'open-view': [view: string]
  'note-created': []
}>()

const MODELS = [
  { id: 'claude-opus-4-6',          label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6',        label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const
type ModelId = typeof MODELS[number]['id']

const inputText = ref('')
const messagesEndRef = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const selectedModel = ref<ModelId>('claude-sonnet-4-6')

// ── File attachment (shared composable) ──────────────────────────────────────
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

// ── @mention + [[note link pickers (shared composables) ──────────────────────
const {
  mentionActive,
  mentionResults,
  mentionIndex,
  mentionedEntities,
  updateState: updateMentionState,
  handleKeydown: handleMentionKeydown,
  pick: pickMention,
  close: closeMention,
  removeEntity: removeMentionEntity,
} = useInputMention(textareaRef, inputText, adjustTextareaHeight)

const {
  noteLinkActive,
  noteLinkResults,
  noteLinkIndex,
  mentionedNotes,
  updateState: updateNoteLinkState,
  handleKeydown: handleNoteLinkKeydown,
  pick: pickNote,
  close: closeNoteLinkPicker,
  removeNote: removeNoteLinkNote,
} = useInputNoteLink(textareaRef, inputText, adjustTextareaHeight)

// Configure marked: no GFM tables/extensions needed beyond basic, keep it safe
marked.setOptions({ breaks: true })

onMounted(() => {
  nextTick(() => {
    textareaRef.value?.focus()
    messagesEndRef.value?.scrollIntoView({ behavior: 'instant' })
  })
})

function scrollToBottom(): void {
  nextTick(() => {
    messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })
  })
}

watch(
  () => messages.value.length,
  () => scrollToBottom(),
)

function adjustTextareaHeight(): void {
  const el = textareaRef.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
}

function onInputWithMention(): void {
  adjustTextareaHeight()
  const hadMention = updateMentionState(closeNoteLinkPicker)
  if (!hadMention) updateNoteLinkState(closeMention)
}

function onClear(): void {
  clearMessages()
  mentionedEntities.value = []
  mentionedNotes.value = []
}

async function send(): Promise<void> {
  const text = inputText.value.trim()
  if ((!text && attachedImages.value.length === 0 && attachedFiles.value.length === 0) || isLoading.value) return

  inputText.value = ''
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = 'auto'
  })

  const imagesToSend = attachedImages.value.map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType }))
  attachedImages.value = []

  const filesToSend = attachedFiles.value.map(({ name, content, mimeType }) => ({ name, content, mimeType }))
  const fileNamesForDisplay = attachedFiles.value.map(({ name }) => ({ name }))
  attachedFiles.value = []

  const userMsg: ChatMessage = {
    role: 'user',
    content: text,
    images: imagesToSend.length > 0 ? imagesToSend.map(({ dataUrl }) => ({ dataUrl })) : undefined,
    files: fileNamesForDisplay.length > 0 ? fileNamesForDisplay : undefined,
  }
  messages.value.push(userMsg)

  isLoading.value = true
  try {
    const apiMessages = messages.value
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))

    const result = (await window.api.invoke('chat:send', {
      messages: apiMessages,
      searchQuery: text,
      images: imagesToSend,
      files: filesToSend.length > 0 ? filesToSend : undefined,
      model: selectedModel.value,
      mentionedEntityIds: mentionedEntities.value.length > 0
        ? mentionedEntities.value.map((e) => e.id)
        : undefined,
      mentionedNoteIds: mentionedNotes.value.length > 0
        ? mentionedNotes.value.map((n) => n.id)
        : undefined,
    })) as { content: string; references: { id: string; title: string }[]; actions: ExecutedAction[] }

    messages.value.push({
      role: 'assistant',
      content: result.content,
      references: result.references,
      actions: result.actions,
    })
    if (result.actions?.some((a) => a.type === 'created_note')) {
      emit('note-created')
    }
  } catch {
    messages.value.push({
      role: 'assistant',
      content: 'An error occurred. Please try again.',
      error: true,
    })
  } finally {
    isLoading.value = false
    nextTick(() => textareaRef.value?.focus())
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (handleMentionKeydown(e)) return
  if (handleNoteLinkKeydown(e)) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

function openNote(e: MouseEvent, noteId: string, title: string): void {
  const mode: OpenMode = e.metaKey || e.ctrlKey ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId, title, mode })
}

// ── Action card helpers ────────────────────────────────────────────────────

interface ActionCardMeta {
  icon: string
  label: string
  variant: 'green' | 'blue' | 'red'
  linkView?: 'calendar' | 'actions'
  linkLabel: string
}

function actionCardMeta(type: ExecutedAction['type']): ActionCardMeta {
  switch (type) {
    case 'created_event':  return { icon: 'CalendarPlus',  label: 'Created event',          variant: 'green', linkView: 'calendar', linkLabel: 'Open Calendar' }
    case 'updated_event':  return { icon: 'CalendarCheck', label: 'Updated event',          variant: 'blue',  linkView: 'calendar', linkLabel: 'Open Calendar' }
    case 'deleted_event':  return { icon: 'CalendarX',     label: 'Deleted event',          variant: 'red',   linkView: 'calendar', linkLabel: 'Open Calendar' }
    case 'created_action': return { icon: 'ListPlus',      label: 'Created action item',    variant: 'green', linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'updated_action': return { icon: 'CheckSquare',   label: 'Updated action item',    variant: 'blue',  linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'deleted_action': return { icon: 'SquareMinus',   label: 'Deleted action item',    variant: 'red',   linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'created_note':   return { icon: 'FilePlus',      label: 'Created note',           variant: 'green',                       linkLabel: 'Open Note'     }
  }
}

function onActionCardLink(e: MouseEvent, action: ExecutedAction): void {
  if (action.type === 'created_note') {
    const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
    emit('open-note', { noteId: String(action.payload.id), title: action.payload.title ?? 'Untitled', mode })
  } else {
    const meta = actionCardMeta(action.type)
    if (meta.linkView) emit('open-view', meta.linkView)
  }
}

function formatActionPayload(action: ExecutedAction): string {
  const p = action.payload
  const parts: string[] = []
  if (p.title) parts.push(p.title)
  if (p.start_at) {
    try {
      const start = new Date(p.start_at)
      const end = p.end_at ? new Date(p.end_at) : null
      const date = start.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })
      const startT = start.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
      const endT = end ? end.toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' }) : null
      parts.push(`${date} · ${startT}${endT ? `–${endT}` : ''}`)
    } catch {
      parts.push(p.start_at)
    }
  }
  if (p.status) parts.push(p.status)
  if (p.due_date) parts.push(`due ${p.due_date}`)
  if (p.assigned_entity_name) parts.push(`→ ${p.assigned_entity_name}`)
  return parts.join(' · ')
}

/** Event delegation — handles clicks on note-ref buttons rendered inside v-html */
function onBubbleClick(e: MouseEvent, msg: ChatMessage): void {
  const btn = (e.target as HTMLElement).closest('[data-note-id]') as HTMLElement | null
  if (!btn) return
  const noteId = btn.dataset.noteId
  const noteTitle = btn.dataset.noteTitle ?? ''
  if (noteId) openNote(e, noteId, noteTitle)
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Convert assistant message content to safe HTML with Markdown rendered and
 * [Note: "Title"] citations replaced by clickable chip buttons.
 *
 * Strategy: replace note-ref patterns with unique placeholders before handing
 * to marked (so the markdown parser never sees the brackets), then substitute
 * placeholders with the final button HTML in the marked output.
 */
function renderMessage(content: string, references: { id: string; title: string }[]): string {
  const titles: string[] = []

  // 1. Swap out [Note: "Title"] for inert placeholders
  const withPlaceholders = content.replace(/\[Note:\s*"([^"]+)"\]/g, (_match, title: string) => {
    titles.push(title)
    return `WIZZREF${titles.length - 1}WIZZREF`
  })

  // 2. Parse Markdown
  const html = marked.parse(withPlaceholders) as string

  // 3. Replace placeholders with styled buttons
  return html.replace(/WIZZREF(\d+)WIZZREF/g, (_m, idxStr: string) => {
    const title = titles[Number(idxStr)] ?? ''
    const ref = references.find((r) => r.title.toLowerCase() === title.toLowerCase())
    if (ref) {
      return `<button class="chat-note-ref" data-note-id="${escapeAttr(ref.id)}" data-note-title="${escapeAttr(ref.title)}">${escapeHtml(title)}</button>`
    }
    return `<span class="chat-note-ref-plain">${escapeHtml(title)}</span>`
  })
}
</script>

<template>
  <div
    class="chat-sidebar"
    :class="{ 'chat-sidebar--drag-over': isDragOver }"
    @dragover.prevent="isDragOver = true"
    @dragleave="isDragOver = false"
    @drop.prevent="onDrop"
  >
    <!-- Header -->
    <div class="chat-header">
      <span class="chat-header-icon"><MessageSquare :size="14" /></span>
      <span class="chat-header-title">Ask Wizz</span>
      <select v-model="selectedModel" class="chat-model-select" title="Claude model">
        <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
      <button
        v-if="messages.length > 0"
        class="chat-action-btn"
        title="Clear conversation"
        @click="onClear"
      >
        <Trash2 :size="13" />
      </button>
      <button class="chat-action-btn" title="Close" @click="emit('close')">
        <X :size="14" />
      </button>
    </div>

    <!-- Messages -->
    <div class="chat-messages">
      <div v-if="messages.length === 0" class="chat-empty">
        <MessageSquare :size="28" class="chat-empty-icon" />
        <p>Ask anything about your notes</p>
        <p class="chat-empty-hint">Wizz searches your knowledge base and answers with citations.</p>
      </div>

      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="chat-message"
        :class="msg.role === 'user' ? 'chat-message-user' : 'chat-message-assistant'"
      >
        <!-- User bubble: plain text + optional image thumbnails + file chips -->
        <template v-if="msg.role === 'user'">
          <div v-if="msg.images && msg.images.length > 0" class="chat-msg-images">
            <img
              v-for="(img, ii) in msg.images"
              :key="ii"
              :src="img.dataUrl"
              class="chat-msg-img"
              alt=""
            />
          </div>
          <div v-if="msg.files && msg.files.length > 0" class="chat-msg-files">
            <span v-for="(f, fi) in msg.files" :key="fi" class="chat-msg-file-chip">
              <FileText :size="11" />{{ f.name }}
            </span>
          </div>
          <div v-if="msg.content" class="chat-bubble chat-bubble-user">{{ msg.content }}</div>
        </template>

        <!-- Assistant bubble: Markdown + inline note chips via v-html + event delegation -->
        <div
          v-else
          class="chat-bubble chat-bubble-assistant"
          :class="{ 'chat-bubble-error': msg.error }"
          v-html="renderMessage(msg.content, msg.references ?? [])"
          @click="onBubbleClick($event, msg)"
        />

        <!-- Action cards (shown for assistant messages that executed tools) -->
        <template v-if="msg.role === 'assistant' && msg.actions && msg.actions.length > 0">
          <div
            v-for="(action, ai) in msg.actions"
            :key="ai"
            class="action-card"
            :class="`action-card--${actionCardMeta(action.type).variant}`"
          >
            <div class="action-card-body">
              <span class="action-card-label">{{ actionCardMeta(action.type).label }}</span>
              <span class="action-card-detail">{{ formatActionPayload(action) }}</span>
            </div>
            <button
              v-if="actionCardMeta(action.type).variant !== 'red'"
              class="action-card-link"
              @click="onActionCardLink($event, action)"
            >
              {{ actionCardMeta(action.type).linkLabel }} →
            </button>
          </div>
        </template>
      </div>

      <!-- Loading indicator -->
      <div v-if="isLoading" class="chat-message chat-message-assistant">
        <div class="chat-bubble chat-bubble-assistant chat-bubble-loading">
          <span class="dot" /><span class="dot" /><span class="dot" />
        </div>
      </div>

      <div ref="messagesEndRef" />
    </div>

    <!-- Attachments bar (images + files + mentioned entities + pinned notes) -->
    <div v-if="attachedImages.length > 0 || attachedFiles.length > 0 || mentionedEntities.length > 0 || mentionedNotes.length > 0" class="chat-attachments-bar">
      <AttachmentBar
        :attached-images="attachedImages"
        :attached-files="attachedFiles"
        @remove-image="removeImage"
        @remove-file="removeFile"
      />
      <!-- Mentioned entity chips -->
      <div
        v-for="entity in mentionedEntities"
        :key="entity.id"
        class="chat-mention-chip"
      >
        <span class="chat-mention-chip-name">@{{ entity.name }}</span>
        <span class="chat-mention-chip-type">{{ entity.type_name }}</span>
        <button class="chat-chip-remove" title="Remove" @click="removeMentionEntity(entity.id)">
          <X :size="10" />
        </button>
      </div>
      <!-- Pinned note chips -->
      <div
        v-for="note in mentionedNotes"
        :key="note.id"
        class="chat-note-chip"
      >
        <FileText :size="11" class="chat-note-chip-icon" />
        <span class="chat-note-chip-title">{{ note.title }}</span>
        <button class="chat-chip-remove" title="Remove" @click="removeNoteLinkNote(note.id)">
          <X :size="10" />
        </button>
      </div>
    </div>

    <!-- File drop/type error -->
    <div v-if="dropError" class="chat-drop-error">{{ dropError }}</div>

    <!-- Hidden file input -->
    <input
      ref="fileInputRef"
      type="file"
      :accept="SUPPORTED_ALL_ACCEPT"
      multiple
      style="display: none"
      @change="onFileInputChange"
    />

    <!-- Input -->
    <div class="chat-input-area">
      <!-- @mention entity picker (floats above input) -->
      <div v-if="mentionActive && mentionResults.length > 0" class="mention-picker">
        <button
          v-for="(entity, i) in mentionResults"
          :key="entity.id"
          class="mention-option"
          :class="{ 'mention-option--active': i === mentionIndex }"
          @mousedown.prevent="pickMention(entity)"
        >
          <span class="mention-option-name">@{{ entity.name }}</span>
          <span class="mention-option-type">{{ entity.type_name }}</span>
        </button>
      </div>
      <!-- [[note link picker (floats above input) -->
      <div v-if="noteLinkActive && noteLinkResults.length > 0" class="mention-picker">
        <button
          v-for="(note, i) in noteLinkResults"
          :key="note.id"
          class="mention-option"
          :class="{ 'mention-option--active': i === noteLinkIndex }"
          @mousedown.prevent="pickNote(note)"
        >
          <span class="mention-option-name">
            <FileText :size="12" style="margin-right: 5px; opacity: 0.6; flex-shrink: 0;" />{{ note.title }}
          </span>
        </button>
      </div>
      <button
        class="chat-attach-btn"
        :disabled="isLoading"
        title="Attach file (PDF, TXT, CSV, MD)"
        @click="fileInputRef?.click()"
      >
        <Paperclip :size="14" />
      </button>
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="chat-input"
        placeholder="Ask about your notes… (@ entity, [[ note)"
        rows="1"
        :disabled="isLoading"
        @keydown="onKeydown"
        @input="onInputWithMention"
        @paste="onPaste"
        @blur="closeMention(); closeNoteLinkPicker()"
      />
      <button
        class="chat-send-btn"
        :disabled="(!inputText.trim() && attachedImages.length === 0 && attachedFiles.length === 0) || isLoading"
        title="Send (Enter)"
        @click="send"
      >
        <Send :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 360px;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);
  border-left: 1px solid var(--color-border);
  z-index: 200;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.25);
}

/* ── Header ── */

.chat-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 44px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
  background: var(--color-surface);
}

.chat-header-icon {
  color: var(--color-text-muted);
  display: flex;
  align-items: center;
}

.chat-header-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.chat-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--color-text-muted);
  cursor: pointer;
}

.chat-action-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.chat-model-select {
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

.chat-model-select:hover,
.chat-model-select:focus {
  border-color: var(--color-accent);
  color: var(--color-text);
}

/* ── Messages ── */

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 8px;
  color: var(--color-text-muted);
  padding: 32px 16px;
}

.chat-empty-icon {
  opacity: 0.25;
  margin-bottom: 4px;
}

.chat-empty p {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-muted);
}

.chat-empty-hint {
  font-size: 12px !important;
  font-weight: 400 !important;
  opacity: 0.7;
  line-height: 1.5;
}

.chat-message {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.chat-message-user {
  align-items: flex-end;
}

.chat-message-assistant {
  align-items: flex-start;
}

.chat-bubble {
  max-width: 92%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.55;
  word-break: break-word;
}

.chat-msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
  max-width: 92%;
}

.chat-msg-img {
  width: 100px;
  height: 100px;
  object-fit: cover;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  display: block;
}

.chat-bubble-user {
  background: var(--color-accent);
  color: #fff;
  border-bottom-right-radius: 4px;
  white-space: pre-wrap;
}

.chat-bubble-assistant {
  background: var(--color-surface);
  color: var(--color-text);
  border-bottom-left-radius: 4px;
  border: 1px solid var(--color-border);
}

.chat-bubble-error {
  border-color: rgba(220, 80, 80, 0.4) !important;
  color: #e07070 !important;
}

/* Typing indicator */
.chat-bubble-loading {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-muted);
  animation: bounce 1.2s infinite;
}

.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes bounce {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* ── Markdown styles inside assistant bubbles (scoped via :deep) ── */

.chat-bubble-assistant :deep(p) {
  margin: 0 0 8px;
}
.chat-bubble-assistant :deep(p:last-child) {
  margin-bottom: 0;
}
.chat-bubble-assistant :deep(ul),
.chat-bubble-assistant :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 18px;
}
.chat-bubble-assistant :deep(li) {
  margin-bottom: 3px;
}
.chat-bubble-assistant :deep(strong) {
  font-weight: 600;
  color: var(--color-text);
}
.chat-bubble-assistant :deep(em) {
  font-style: italic;
}
.chat-bubble-assistant :deep(code) {
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.07);
  border-radius: 3px;
  padding: 1px 4px;
}
.chat-bubble-assistant :deep(pre) {
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
  padding: 8px 10px;
  overflow-x: auto;
  margin: 6px 0;
}
.chat-bubble-assistant :deep(pre code) {
  background: transparent;
  padding: 0;
}
.chat-bubble-assistant :deep(h1),
.chat-bubble-assistant :deep(h2),
.chat-bubble-assistant :deep(h3) {
  font-weight: 600;
  margin: 10px 0 4px;
  color: var(--color-text);
}
.chat-bubble-assistant :deep(h1) { font-size: 15px; }
.chat-bubble-assistant :deep(h2) { font-size: 14px; }
.chat-bubble-assistant :deep(h3) { font-size: 13px; }
.chat-bubble-assistant :deep(blockquote) {
  border-left: 2px solid var(--color-border);
  padding-left: 10px;
  color: var(--color-text-muted);
  margin: 4px 0;
}
.chat-bubble-assistant :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: 8px 0;
}

/* Note reference chip injected by renderMessage() */
.chat-bubble-assistant :deep(.chat-note-ref) {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px;
  border-radius: 10px;
  font-size: 11.5px;
  font-weight: 500;
  background: rgba(91, 141, 239, 0.15);
  color: var(--color-accent);
  border: 1px solid rgba(91, 141, 239, 0.3);
  cursor: pointer;
  vertical-align: middle;
  white-space: nowrap;
  transition: background 0.1s;
  font-family: inherit;
  line-height: 1.4;
}
.chat-bubble-assistant :deep(.chat-note-ref:hover) {
  background: rgba(91, 141, 239, 0.25);
}
.chat-bubble-assistant :deep(.chat-note-ref-plain) {
  color: var(--color-text-muted);
  font-style: italic;
}

/* ── Drag-over state ── */

.chat-sidebar--drag-over {
  outline: 2px dashed var(--color-accent);
  outline-offset: -4px;
}

/* ── Attachments bar ── */

.chat-attachments-bar {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
  overflow-x: auto;
  background: var(--color-surface);
}

/* ── Input area ── */

.chat-input-area {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.chat-input {
  flex: 1;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 10px;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.5;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 120px;
  overflow-y: auto;
}

.chat-input:focus {
  border-color: var(--color-accent);
}

.chat-input::placeholder {
  color: var(--color-text-muted);
}

.chat-input:disabled {
  opacity: 0.5;
}

.chat-send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  background: var(--color-accent);
  border: none;
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.chat-send-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.chat-send-btn:not(:disabled):hover {
  opacity: 0.85;
}

/* ── Action cards ── */

.action-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 11px;
  border-radius: 8px;
  border: 1px solid transparent;
  max-width: 92%;
  font-size: 12px;
}

.action-card--green {
  background: rgba(52, 168, 83, 0.1);
  border-color: rgba(52, 168, 83, 0.25);
}

.action-card--blue {
  background: rgba(91, 141, 239, 0.1);
  border-color: rgba(91, 141, 239, 0.25);
}

.action-card--red {
  background: rgba(220, 80, 80, 0.08);
  border-color: rgba(220, 80, 80, 0.2);
}

.action-card-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.action-card-label {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
}

.action-card--green .action-card-label { color: #34a853; }
.action-card--blue  .action-card-label { color: var(--color-accent); }
.action-card--red   .action-card-label { color: #dc5050; }

.action-card-detail {
  color: var(--color-text-muted);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.action-card-link {
  flex-shrink: 0;
  background: transparent;
  border: none;
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  white-space: nowrap;
  color: var(--color-text-muted);
  transition: color 0.1s;
}

.action-card-link:hover {
  color: var(--color-text);
}

/* ── File chips in sent messages ── */

.chat-msg-files {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  justify-content: flex-end;
  max-width: 92%;
}

.chat-msg-file-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.15);
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Entity/note chip inline remove button ── */

.chat-chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  opacity: 0.5;
  padding: 0;
  flex-shrink: 0;
}

.chat-chip-remove:hover {
  opacity: 1;
  background: rgba(220, 80, 80, 0.15);
  color: #ef4444;
}

/* ── Drop error ── */

.chat-drop-error {
  font-size: 11px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 4px;
  padding: 5px 10px;
  margin: 0 8px;
}

/* ── Attach button ── */

.chat-attach-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 34px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  border-radius: 6px;
  transition: color 0.1s, background 0.1s;
}

.chat-attach-btn:hover:not(:disabled) {
  color: var(--color-text);
  background: var(--color-hover);
}

.chat-attach-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* ── @mention picker ── */

.mention-picker {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 -4px 20px rgba(0, 0, 0, 0.3);
  z-index: 100;
  max-height: 240px;
  overflow-y: auto;
}

.mention-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 7px 12px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
  cursor: pointer;
  gap: 8px;
  font-family: inherit;
}

.mention-option:last-child {
  border-bottom: none;
}

.mention-option:hover,
.mention-option--active {
  background: var(--color-hover);
}

.mention-option-name {
  font-size: 13px;
  color: var(--color-text);
  font-weight: 500;
}

.mention-option-type {
  font-size: 11px;
  color: var(--color-text-muted);
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}

/* ── Note chips in attachments bar ── */

.chat-note-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  background: rgba(52, 168, 83, 0.1);
  border: 1px solid rgba(52, 168, 83, 0.25);
  white-space: nowrap;
  flex-shrink: 0;
}

.chat-note-chip-icon {
  color: #34a853;
  flex-shrink: 0;
}

.chat-note-chip-title {
  color: #34a853;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Entity mention chips in attachments bar ── */

.chat-mention-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  background: rgba(91, 141, 239, 0.1);
  border: 1px solid rgba(91, 141, 239, 0.25);
  white-space: nowrap;
  flex-shrink: 0;
}

.chat-mention-chip-name {
  color: var(--color-accent);
}

.chat-mention-chip-type {
  font-size: 10.5px;
  color: var(--color-text-muted);
  font-weight: 400;
}
</style>
