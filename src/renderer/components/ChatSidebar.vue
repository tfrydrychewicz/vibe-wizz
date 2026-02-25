<script setup lang="ts">
import { ref, nextTick, watch, onMounted } from 'vue'
import { marked } from 'marked'
import { X, Trash2, Send, MessageSquare, CalendarPlus, CalendarCheck, CalendarX, ListPlus, CheckSquare, SquareMinus } from 'lucide-vue-next'
import { messages, isLoading, clearMessages, type ChatMessage, type ExecutedAction } from '../stores/chatStore'
import type { OpenMode } from '../stores/tabStore'

const emit = defineEmits<{
  close: []
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
  'open-view': [view: string]
}>()

const inputText = ref('')
const messagesEndRef = ref<HTMLElement | null>(null)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

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

async function send(): Promise<void> {
  const text = inputText.value.trim()
  if (!text || isLoading.value) return

  inputText.value = ''
  nextTick(() => {
    if (textareaRef.value) textareaRef.value.style.height = 'auto'
  })

  const userMsg: ChatMessage = { role: 'user', content: text }
  messages.value.push(userMsg)

  isLoading.value = true
  try {
    const apiMessages = messages.value
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))

    const result = (await window.api.invoke('chat:send', {
      messages: apiMessages,
      searchQuery: text,
    })) as { content: string; references: { id: string; title: string }[]; actions: ExecutedAction[] }

    messages.value.push({
      role: 'assistant',
      content: result.content,
      references: result.references,
      actions: result.actions,
    })
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
  linkView: 'calendar' | 'actions'
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
  <div class="chat-sidebar">
    <!-- Header -->
    <div class="chat-header">
      <span class="chat-header-icon"><MessageSquare :size="14" /></span>
      <span class="chat-header-title">Ask Wizz</span>
      <button
        v-if="messages.length > 0"
        class="chat-action-btn"
        title="Clear conversation"
        @click="clearMessages"
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
        <!-- User bubble: plain text -->
        <div v-if="msg.role === 'user'" class="chat-bubble chat-bubble-user">{{ msg.content }}</div>

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
              @click="emit('open-view', actionCardMeta(action.type).linkView)"
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

    <!-- Input -->
    <div class="chat-input-area">
      <textarea
        ref="textareaRef"
        v-model="inputText"
        class="chat-input"
        placeholder="Ask about your notes…"
        rows="1"
        :disabled="isLoading"
        @keydown="onKeydown"
        @input="adjustTextareaHeight"
      />
      <button
        class="chat-send-btn"
        :disabled="!inputText.trim() || isLoading"
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

/* ── Input area ── */

.chat-input-area {
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
</style>
