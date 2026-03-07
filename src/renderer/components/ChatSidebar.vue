<script setup lang="ts">
import { ref, nextTick, watch, onMounted, onUnmounted } from 'vue'
import { marked } from 'marked'
import { Trash2, Send, MessageSquare, CalendarPlus, CalendarCheck, CalendarX, ListPlus, CheckSquare, SquareMinus, FilePlus, Paperclip, FileText, X, Globe } from 'lucide-vue-next'
import { messages, isLoading, clearMessages, selectedModelId, type ChatMessage, type ExecutedAction } from '../stores/chatStore'
import { pendingNoteJump } from '../stores/noteJumpStore'
import type { OpenMode } from '../stores/tabStore'
import { useFileAttachment, SUPPORTED_ALL_ACCEPT } from '../composables/useFileAttachment'
import { useEntityChips } from '../composables/useEntityChips'
import { renderEntityChip, renderNoteChip, renderWebLinkChip, renderSelectionChip, renderActionChip, renderEventChip, escapeHtml } from '../utils/markdown'
import { fireShowInlineDetail } from '../stores/taskInlineDetailStore'
import AttachmentBar from './AttachmentBar.vue'
import RichTextInput from './RichTextInput.vue'
import ModelSelect from './ModelSelect.vue'
import AgentStepProgress from './AgentStepProgress.vue'
import WebSearchIndicator from './WebSearchIndicator.vue'
import type { RichInputContent } from './RichTextInput.vue'
import type { StepProgress } from './AgentStepProgress.vue'

const emit = defineEmits<{
  close: []
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
  'open-entity': [{ entityId: string; typeId?: string; mode: OpenMode }]
  'open-view': [view: string]
  'note-created': []
  'navigate-to-event': [{ eventId: number; clientX: number; clientY: number }]
}>()

const messagesContainerRef = ref<HTMLElement | null>(null)
const messagesEndRef = ref<HTMLElement | null>(null)
const richInputRef = ref<InstanceType<typeof RichTextInput> | null>(null)
const fileInputRef = ref<HTMLInputElement | null>(null)
const chatModels = ref<{ id: string; label: string }[]>([])
const hasContent = ref(false)

// ── Agent step progress ───────────────────────────────────────────────────────
const agentSteps = ref<StepProgress[]>([])
const agentPhase = ref<'idle' | 'classifying' | 'planning' | 'executing' | 'done'>('idle')
const agentProgressCollapsed = ref(false)
const msgStepsCollapsed = ref(new Map<number, boolean>())
function toggleMsgSteps(i: number): void {
  msgStepsCollapsed.value.set(i, !isMsgStepsCollapsed(i))
}
function isMsgStepsCollapsed(i: number): boolean {
  return msgStepsCollapsed.value.get(i) ?? true
}

// ── Web search indicator ──────────────────────────────────────────────────────
/** Query currently being searched — non-empty while a web_search tool call is in flight. */
const webSearchQuery = ref('')
/** Whether local web search is enabled (loaded from settings on mount). */
const webSearchEnabled = ref(false)

let unsubAgentProgress: (() => void) | null = null
let unsubAgentPhase: (() => void) | null = null
let unsubWebSearch: (() => void) | null = null

onMounted(async () => {
  const webSearchSetting = await window.api.invoke('settings:get', { key: 'web_search_enabled' }) as string | null
  webSearchEnabled.value = webSearchSetting === 'true'

  unsubAgentPhase = window.api.on('agent:phase', (data: unknown) => {
    const { phase } = data as { phase: typeof agentPhase.value; stepCount?: number }
    agentPhase.value = phase
    scrollToBottom()
  })

  unsubAgentProgress = window.api.on('agent:step-progress', (data: unknown) => {
    const step = data as StepProgress
    const idx = agentSteps.value.findIndex((s) => s.stepId === step.stepId)
    if (idx >= 0) {
      agentSteps.value[idx] = step
    } else {
      agentSteps.value.push(step)
    }
    scrollToBottom()
  })

  unsubWebSearch = window.api.on('web-search:performed', (data: unknown) => {
    const { query } = data as { query: string }
    webSearchQuery.value = query
    scrollToBottom()
  })
})

onUnmounted(() => {
  unsubAgentPhase?.()
  unsubAgentProgress?.()
  unsubWebSearch?.()
})

// Clear the web search indicator once the response arrives
watch(isLoading, (loading) => {
  if (!loading) webSearchQuery.value = ''
})

const { applyToElement: applyChips } = useEntityChips()

watch(() => messages.value.length, async () => {
  await nextTick()
  if (messagesContainerRef.value) void applyChips(messagesContainerRef.value)
})

// ── File attachment ───────────────────────────────────────────────────────────
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

// Configure marked
marked.setOptions({ breaks: true })

onMounted(async () => {
  nextTick(() => {
    richInputRef.value?.focus()
    messagesEndRef.value?.scrollIntoView({ behavior: 'instant' })
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

function scrollToBottom(): void {
  nextTick(() => {
    messagesEndRef.value?.scrollIntoView({ behavior: 'smooth' })
  })
}

watch(() => messages.value.length, () => scrollToBottom())

function onContentChange(): void {
  hasContent.value = !(richInputRef.value?.isEmpty() ?? true)
}

function onClear(): void {
  clearMessages()
  richInputRef.value?.clear()
}

async function send(): Promise<void> {
  if (!richInputRef.value || isLoading.value) return
  const { text, displayContent, mentionedEntityIds, mentionedEntities, mentionedNoteIds, mentionedNotes, selections }: RichInputContent = richInputRef.value.getContent()

  const hasFiles = attachedImages.value.length > 0 || attachedFiles.value.length > 0
  const hasContext = selections.length > 0 || mentionedEntityIds.length > 0 || mentionedNoteIds.length > 0
  if (!text && !hasFiles && !hasContext) return

  richInputRef.value.clear()
  hasContent.value = false

  const imagesToSend = attachedImages.value.map(({ dataUrl, mimeType }) => ({ dataUrl, mimeType }))
  attachedImages.value = []

  const filesToSend = attachedFiles.value.map(({ name, content, mimeType }) => ({ name, content, mimeType }))
  const fileNamesForDisplay = attachedFiles.value.map(({ name }) => ({ name }))
  attachedFiles.value = []

  // Plain objects required for Electron IPC structured clone
  const selectionsToSend = selections.map((s) => ({ ...s }))

  const userMsg: ChatMessage = {
    role: 'user',
    content: text,
    displayContent: displayContent !== text ? displayContent : undefined,
    images: imagesToSend.length > 0 ? imagesToSend.map(({ dataUrl }) => ({ dataUrl })) : undefined,
    files: fileNamesForDisplay.length > 0 ? fileNamesForDisplay : undefined,
    noteSelections: selectionsToSend.length > 0 ? selectionsToSend : undefined,
    mentionedEntities: mentionedEntities.length > 0 ? mentionedEntities.map((e) => ({ ...e })) : undefined,
    mentionedNotes: mentionedNotes.length > 0 ? mentionedNotes.map((n) => ({ ...n })) : undefined,
  }
  messages.value.push(userMsg)

  isLoading.value = true
  agentSteps.value = []
  agentPhase.value = 'idle'
  webSearchQuery.value = ''
  try {
    const apiMessages = messages.value
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }))

    const result = (await window.api.invoke('chat:send', {
      messages: apiMessages,
      searchQuery: text,
      images: imagesToSend,
      files: filesToSend.length > 0 ? filesToSend : undefined,
      noteSelections: selectionsToSend.length > 0 ? selectionsToSend : undefined,
      overrideModelId: selectedModelId.value || undefined,
      mentionedEntityIds: mentionedEntityIds.length > 0 ? mentionedEntityIds : undefined,
      mentionedNoteIds: mentionedNoteIds.length > 0 ? mentionedNoteIds : undefined,
    })) as { content: string; references: { id: string; title: string }[]; actions: ExecutedAction[]; entityRefs: { id: string; name: string }[]; warning?: string; generatedImages?: { path: string; prompt: string }[] }

    messages.value.push({
      role: 'assistant',
      content: result.content,
      references: result.references,
      entityRefs: result.entityRefs,
      actions: result.actions,
      warning: result.warning,
      generatedImages: result.generatedImages,
      agentSteps: agentSteps.value.length > 0 ? [...agentSteps.value] : undefined,
    })
    if (result.actions?.some((a) => a.type === 'created_note')) emit('note-created')
  } catch (err) {
    console.error('[Chat] send failed:', err)
    messages.value.push({ role: 'assistant', content: 'An error occurred. Please try again.', error: true })
  } finally {
    isLoading.value = false
    agentSteps.value = []
    agentPhase.value = 'idle'
    nextTick(() => richInputRef.value?.focus())
  }
}

function openNote(e: MouseEvent, noteId: string, title: string): void {
  const mode: OpenMode = e.metaKey || e.ctrlKey ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId, title, mode })
}

function openEntity(e: MouseEvent, entityId: string): void {
  const mode: OpenMode = e.metaKey || e.ctrlKey ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-entity', { entityId, mode })
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
    case 'created_event':         return { icon: 'CalendarPlus',  label: 'Created event',           variant: 'green', linkView: 'calendar', linkLabel: 'Open Calendar' }
    case 'updated_event':         return { icon: 'CalendarCheck', label: 'Updated event',           variant: 'blue',  linkView: 'calendar', linkLabel: 'Open Calendar' }
    case 'deleted_event':         return { icon: 'CalendarX',     label: 'Deleted event',           variant: 'red',   linkView: 'calendar', linkLabel: 'Open Calendar' }
    case 'created_action':        return { icon: 'ListPlus',      label: 'Created action item',     variant: 'green', linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'updated_action':        return { icon: 'CheckSquare',   label: 'Updated action item',     variant: 'blue',  linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'deleted_action':        return { icon: 'SquareMinus',   label: 'Deleted action item',     variant: 'red',   linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'created_note':          return { icon: 'FilePlus',      label: 'Created note',            variant: 'green',                       linkLabel: 'Open Note'     }
    case 'created_entity':        return { icon: 'UserPlus',      label: 'Created entity',          variant: 'green',                       linkLabel: ''              }
    case 'updated_entity':        return { icon: 'UserCheck',     label: 'Updated entity',          variant: 'blue',                        linkLabel: ''              }
    case 'ensured_action_created': return { icon: 'Link',         label: 'Created & linked task',   variant: 'green', linkView: 'actions',  linkLabel: 'Open Actions'  }
    case 'ensured_action_found':   return { icon: 'Link2',        label: 'Linked existing task',    variant: 'blue',  linkView: 'actions',  linkLabel: 'Open Actions'  }
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
  if (p.name) parts.push(p.type_name ? `${p.name} (${p.type_name})` : p.name)
  if (!p.name && p.title) parts.push(p.title)
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

/** Event delegation — handles clicks on note-ref, entity-ref, web-link, action, and event chips rendered inside v-html */
function onBubbleClick(e: MouseEvent, _msg: ChatMessage): void {
  const target = e.target as HTMLElement

  const webChip = target.closest('[data-web-url]') as HTMLElement | null
  if (webChip) {
    e.preventDefault()
    const url = webChip.dataset.webUrl
    if (url) void window.api.invoke('shell:open-external', { url })
    return
  }

  const actionChip = target.closest('[data-action-id]') as HTMLElement | null
  if (actionChip) {
    const id = actionChip.dataset.actionId
    if (id) fireShowInlineDetail(id, new DOMRect(e.clientX, e.clientY, 0, 0))
    return
  }

  const eventChip = target.closest('[data-event-id]') as HTMLElement | null
  if (eventChip) {
    const id = eventChip.dataset.eventId
    if (id) emit('navigate-to-event', { eventId: Number(id), clientX: e.clientX, clientY: e.clientY })
    return
  }

  const entityBtn = target.closest('[data-entity-id]') as HTMLElement | null
  if (entityBtn) {
    const entityId = entityBtn.dataset.entityId
    if (entityId) openEntity(e, entityId)
    return
  }

  const noteBtn = target.closest('[data-note-id]') as HTMLElement | null
  if (!noteBtn) return
  const noteId = noteBtn.dataset.noteId
  if (!noteId) return

  // Selection chip — open note AND jump to the copied block range
  if (noteBtn.dataset.blockStart !== undefined) {
    const blockStart = Number(noteBtn.dataset.blockStart)
    const blockEnd   = Number(noteBtn.dataset.blockEnd)
    pendingNoteJump.value = { noteId, blockStart, blockEnd }
    const titleEl = noteBtn.querySelector(`.wizz-note-selection-chip__title`)
    const title = titleEl?.textContent ?? ''
    openNote(e, noteId, title)
    return
  }

  // Plain note chip
  const noteTitle = noteBtn.dataset.noteTitle ?? ''
  openNote(e, noteId, noteTitle)
}

/**
 * Convert assistant message content to safe HTML with Markdown rendered,
 * [Note: "Title"] citations, @EntityName mentions, and [[NoteTitle]] links
 * replaced by clickable chip buttons.
 *
 * Strategy: replace all special patterns with unique placeholders before
 * handing to marked (so the markdown parser never sees the brackets/@ chars),
 * then substitute placeholders with the final button HTML in the marked output.
 */
function renderMessage(
  content: string,
  references: { id: string; title: string }[],
  entityRefs?: { id: string; name: string }[],
): string {
  const noteRefTitles: string[] = []
  const entityRefItems: { id: string; name: string }[] = []
  const noteLinkTitles: string[] = []

  // Build lookup maps
  const noteByTitle = new Map(references.map((r) => [r.title.toLowerCase(), r]))

  // 1a. Swap out {{entity:uuid:Name}} tokens — ID is embedded directly in the response text.
  //     Must run before pass 1b so these are not double-matched.
  const ENTITY_WITH_ID_RE = /\{\{entity:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(.*?)\}\}/g
  let withEntityPlaceholders = content.replace(ENTITY_WITH_ID_RE, (_m, id: string, rawName: string) => {
    const name = rawName.trim()
    entityRefItems.push({ id, name })
    return `WIZZENT${entityRefItems.length - 1}WIZZENT`
  })

  // 1b. Swap out remaining @EntityName tokens using exact name matching from entityRefs.
  //     Sort by name length descending so longer names are matched before shorter prefixes.
  //     Skip names already replaced in pass 1a.
  if (entityRefs && entityRefs.length > 0) {
    const alreadyHandled = new Set(entityRefItems.map((e) => e.name.toLowerCase()))
    const sorted = [...entityRefs].sort((a, b) => b.name.length - a.name.length)
    for (const entity of sorted) {
      if (alreadyHandled.has(entity.name.toLowerCase())) continue
      const escaped = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      withEntityPlaceholders = withEntityPlaceholders.replace(
        new RegExp(`@${escaped}`, 'g'),
        () => {
          entityRefItems.push(entity)
          return `WIZZENT${entityRefItems.length - 1}WIZZENT`
        },
      )
    }
  }

  // 1c. Swap out {{note:uuid:Name}} tokens — ID embedded directly in response text.
  //     Must run before the plain [[Title]] pass so these aren't double-matched.
  const NOTE_WITH_ID_RE = /\{\{note:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}):(.*?)\}\}/g
  const withNoteIdPlaceholders = withEntityPlaceholders.replace(NOTE_WITH_ID_RE, (_m, id: string, title: string) => {
    const trimmedTitle = title.trim()
    // Push into noteRefTitles but also add to references lookup so WIZZREF resolves correctly
    if (!noteByTitle.has(trimmedTitle.toLowerCase())) {
      noteByTitle.set(trimmedTitle.toLowerCase(), { id, title: trimmedTitle })
    }
    noteRefTitles.push(trimmedTitle)
    return `WIZZREF${noteRefTitles.length - 1}WIZZREF`
  })

  // 1d. Swap out [[Note Title]] tokens for noteLink placeholders
  const withNoteLinkPlaceholders = withNoteIdPlaceholders.replace(
    /\[\[([^\]]{1,200})\]\]/g,
    (_match, title: string) => {
      noteLinkTitles.push(title.trim())
      return `WIZZLINK${noteLinkTitles.length - 1}WIZZLINK`
    },
  )

  // 1e. Swap out [Note: "Title"] citations
  const withNoteRefPlaceholders = withNoteLinkPlaceholders.replace(
    /\[Note:\s*"([^"]+)"\]/g,
    (_match, title: string) => {
      noteRefTitles.push(title)
      return `WIZZREF${noteRefTitles.length - 1}WIZZREF`
    },
  )

  // 1f. Swap out Markdown links [label](https://...) before marked sees them,
  //     so they render as web chips rather than plain <a> tags.
  const webLinkItems: { title: string; url: string }[] = []
  const withWebLinkPlaceholders = withNoteRefPlaceholders.replace(
    /\[([^\]]{1,300})\]\((https?:\/\/[^)]{1,2000})\)/g,
    (_match, label: string, url: string) => {
      webLinkItems.push({ title: label.trim(), url: url.trim() })
      return `WIZZURL${webLinkItems.length - 1}WIZZURL`
    },
  )

  // 1g. Swap out {{action:UUID:Title}} tokens → action chip placeholders
  const actionChipItems: { id: string; title: string }[] = []
  const withActionPlaceholders = withWebLinkPlaceholders.replace(
    /\{\{action:([0-9a-fA-F-]{36}):([^}]*)\}\}/g,
    (_m, id: string, title: string) => {
      actionChipItems.push({ id, title: title.trim() })
      return `WIZZACT${actionChipItems.length - 1}WIZZACT`
    },
  )

  // 1h. Swap out {{event:ID:Label}} tokens → event chip placeholders
  const eventChipItems: { id: string; label: string }[] = []
  const withAllPlaceholders = withActionPlaceholders.replace(
    /\{\{event:(\d+):([^}]*)\}\}/g,
    (_m, id: string, label: string) => {
      eventChipItems.push({ id, label: label.trim() })
      return `WIZZEVT${eventChipItems.length - 1}WIZZEVT`
    },
  )

  // 2. Parse Markdown
  const html = marked.parse(withAllPlaceholders) as string

  // 3. Substitute placeholders back with styled buttons
  let result = html

  result = result.replace(/WIZZENT(\d+)WIZZENT/g, (_m, idxStr: string) => {
    const entity = entityRefItems[Number(idxStr)]
    if (!entity) return ''
    return renderEntityChip(entity.id, entity.name)
  })

  result = result.replace(/WIZZLINK(\d+)WIZZLINK/g, (_m, idxStr: string) => {
    const title = noteLinkTitles[Number(idxStr)] ?? ''
    const ref = noteByTitle.get(title.toLowerCase())
    if (ref) return renderNoteChip(ref.id, title)
    return `<span class="wizz-note-chip-plain">[[${escapeHtml(title)}]]</span>`
  })

  result = result.replace(/WIZZREF(\d+)WIZZREF/g, (_m, idxStr: string) => {
    const title = noteRefTitles[Number(idxStr)] ?? ''
    const ref = noteByTitle.get(title.toLowerCase())
    if (ref) return renderNoteChip(ref.id, title)
    return `<span class="wizz-note-chip-plain">${escapeHtml(title)}</span>`
  })

  // 3d. Substitute web link placeholders (from step 1f) with web chips
  result = result.replace(/WIZZURL(\d+)WIZZURL/g, (_m, idxStr: string) => {
    const item = webLinkItems[Number(idxStr)]
    if (!item) return ''
    return renderWebLinkChip(item.title, item.url)
  })

  // 3e. Action item chips (from step 1g)
  result = result.replace(/WIZZACT(\d+)WIZZACT/g, (_m, idxStr: string) => {
    const item = actionChipItems[Number(idxStr)]
    if (!item) return ''
    return renderActionChip(item.id, item.title)
  })

  // 3f. Calendar event chips (from step 1h)
  result = result.replace(/WIZZEVT(\d+)WIZZEVT/g, (_m, idxStr: string) => {
    const item = eventChipItems[Number(idxStr)]
    if (!item) return ''
    return renderEventChip(item.id, item.label)
  })

  // 3e. Convert any remaining <a href="https://..."> tags that marked emitted
  //     (e.g. autolinked bare URLs) into web chips
  result = result.replace(
    /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]*)<\/a>/g,
    (_m, url: string, label: string) => renderWebLinkChip(label || url, url),
  )

  return result
}

/**
 * Render a user message's content as HTML with @mention and [[note-link]] chips
 * substituted inline — mirroring how they appear in the RichTextInput editor.
 */
function renderUserMessage(msg: ChatMessage): string {
  // Use displayContent (which has positional WIZZSEL markers) when available,
  // otherwise fall back to plain content.
  const content = msg.displayContent ?? msg.content
  if (!content) return ''

  // Build lookup maps keyed by lowercase name/title
  const entityByName = new Map<string, { id: string; name: string }>()
  for (const e of msg.mentionedEntities ?? []) entityByName.set(e.name.toLowerCase(), e)

  const noteByTitle = new Map<string, { id: string; title: string }>()
  for (const n of msg.mentionedNotes ?? []) noteByTitle.set(n.title.toLowerCase(), n)

  const entityItems: { id: string; name: string }[] = []
  const noteItems: Array<{ id: string; title: string } | null> = []

  // Replace [[Title]] patterns before escaping
  let result = content.replace(/\[\[([^\]]+)\]\]/g, (_m, title: string) => {
    const note = noteByTitle.get(title.trim().toLowerCase()) ?? { id: '', title: title.trim() }
    noteItems.push(note)
    return `WIZZULINK${noteItems.length - 1}WIZZULINK`
  })

  // Replace @Name patterns — longest name first to avoid prefix shadowing
  const sortedEntities = [...(msg.mentionedEntities ?? [])].sort((a, b) => b.name.length - a.name.length)
  for (const entity of sortedEntities) {
    const escaped = entity.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`@${escaped}`, 'g'), () => {
      entityItems.push(entity)
      return `WIZZUENT${entityItems.length - 1}WIZZUENT`
    })
  }

  // HTML-escape the plain text, then convert newlines
  result = escapeHtml(result).replace(/\n/g, '<br>')

  // Substitute entity placeholders back as chips
  result = result.replace(/WIZZUENT(\d+)WIZZUENT/g, (_m, idxStr: string) => {
    const entity = entityItems[Number(idxStr)]
    return entity ? renderEntityChip(entity.id, entity.name) : ''
  })

  // Substitute note placeholders back as chips
  result = result.replace(/WIZZULINK(\d+)WIZZULINK/g, (_m, idxStr: string) => {
    const note = noteItems[Number(idxStr)]
    if (!note) return ''
    if (note.id) return renderNoteChip(note.id, note.title)
    return `<span class="wizz-note-chip-plain">[[${escapeHtml(note.title)}]]</span>`
  })

  // Substitute selection chip markers inline at their original cursor positions
  result = result.replace(/WIZZSEL(\d+)WIZZSEL/g, (_m, idxStr: string) => {
    const sel = (msg.noteSelections ?? [])[Number(idxStr)]
    return sel ? renderSelectionChip(sel.noteId, sel.noteTitle, sel.blockStart, sel.blockEnd) : ''
  })

  return result
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
      <button
        v-if="webSearchEnabled"
        class="chat-action-btn chat-web-search-badge"
        title="Web Search enabled — configure in Settings"
        @click="emit('open-view', '__settings__')"
      >
        <Globe :size="13" />
      </button>
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
    <div ref="messagesContainerRef" class="chat-messages">
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
          <div
            v-if="msg.content || (msg.noteSelections && msg.noteSelections.length > 0)"
            class="chat-bubble chat-bubble-user"
            v-html="renderUserMessage(msg)"
            @click="onBubbleClick($event, msg)"
          />
        </template>

        <!-- Assistant bubble: Markdown + inline note chips via v-html + event delegation -->
        <template v-else>
          <!-- Persisted agent step progress (for completed agent runs) -->
          <AgentStepProgress
            v-if="msg.agentSteps?.length"
            :steps="msg.agentSteps"
            :collapsed="isMsgStepsCollapsed(i)"
            @toggle="toggleMsgSteps(i)"
          />
          <div
            class="chat-bubble chat-bubble-assistant"
            :class="{ 'chat-bubble-error': msg.error }"
            v-html="renderMessage(msg.content, msg.references ?? [], msg.entityRefs)"
            @click="onBubbleClick($event, msg)"
          />
        </template>

        <!-- Generated images (shown for assistant messages from agent runs) -->
        <div v-if="msg.role === 'assistant' && msg.generatedImages?.length" class="chat-generated-images">
          <div
            v-for="(img, gi) in msg.generatedImages"
            :key="gi"
            class="chat-generated-image"
            :title="img.prompt"
          >
            <img :src="'wizz-file://' + img.path" :alt="img.prompt" />
          </div>
        </div>

        <!-- Fallback warning (shown when a secondary model was used) -->
        <div v-if="msg.role === 'assistant' && msg.warning" class="chat-fallback-warning">
          {{ msg.warning }}
        </div>

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
        <!-- Agent lifecycle phase (shown once the agent kicks in) -->
        <div v-if="agentPhase !== 'idle' && agentPhase !== 'done'" class="agent-phase-label">
          <svg v-if="agentPhase === 'classifying' || agentPhase === 'planning'" class="agent-phase-spinner" width="14" height="14" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2"/>
            <path d="M8 2 A6 6 0 0 1 14 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span v-if="agentPhase === 'classifying'">Analyzing prompt…</span>
          <span v-else-if="agentPhase === 'planning'">Planning steps…</span>
          <span v-else-if="agentPhase === 'executing'">Executing plan…</span>
        </div>
        <!-- Web search in-progress indicator -->
        <WebSearchIndicator v-if="webSearchQuery" :query="webSearchQuery" />
        <!-- Agent step progress (shown during multi-step agent runs) -->
        <AgentStepProgress
          v-if="agentSteps.length > 0"
          :steps="agentSteps"
          :collapsed="agentProgressCollapsed"
          @toggle="agentProgressCollapsed = !agentProgressCollapsed"
        />
      </div>

      <div ref="messagesEndRef" />
    </div>

    <!-- Hidden file input -->
    <input
      ref="fileInputRef"
      type="file"
      :accept="SUPPORTED_ALL_ACCEPT"
      multiple
      style="display: none"
      @change="onFileInputChange"
    />

    <!-- Composer: unified input box (Cursor-style) -->
    <div class="chat-composer">
      <!-- File/image attachments inside the box -->
      <div v-if="attachedImages.length > 0 || attachedFiles.length > 0" class="chat-composer-files">
        <AttachmentBar
          :attached-images="attachedImages"
          :attached-files="attachedFiles"
          @remove-image="removeImage"
          @remove-file="removeFile"
        />
      </div>

      <!-- Rich text input (borderless — box provides the border) -->
      <RichTextInput
        ref="richInputRef"
        placeholder="Ask about your notes…"
        :disabled="isLoading"
        @submit="send"
        @paste="onFilePaste"
        @change="onContentChange"
      />

      <!-- Bottom toolbar -->
      <div class="chat-composer-toolbar">
        <ModelSelect
          v-if="chatModels.length > 0"
          v-model="selectedModelId"
          :models="chatModels"
          :disabled="isLoading"
        />
        <div class="chat-composer-spacer" />
        <button
          class="chat-composer-btn"
          :disabled="isLoading"
          title="Attach file (PDF, TXT, CSV, MD)"
          @click="fileInputRef?.click()"
        >
          <Paperclip :size="14" />
        </button>
        <button
          class="chat-composer-send"
          :disabled="(!hasContent && attachedImages.length === 0 && attachedFiles.length === 0) || isLoading"
          title="Send (Enter)"
          @click="send"
        >
          <Send :size="14" />
        </button>
      </div>

      <!-- Drop/type error -->
      <div v-if="dropError" class="chat-drop-error">{{ dropError }}</div>
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

.chat-web-search-badge {
  color: var(--color-primary, #4f6ef7);
}

.chat-web-search-badge:hover {
  color: var(--color-primary, #4f6ef7);
  background: color-mix(in srgb, var(--color-primary, #4f6ef7) 12%, transparent);
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

/* Chip styling lives in the global style.css (.wizz-entity-chip, .wizz-note-chip, .wizz-note-chip-plain) */

/* ── Drag-over state ── */

.chat-sidebar--drag-over {
  outline: 2px dashed var(--color-accent);
  outline-offset: -4px;
}

/* ── Composer (unified input box, Cursor-style) ── */

.chat-composer {
  margin: 8px 10px 10px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface);
  flex-shrink: 0;
  transition: border-color 0.15s;
  /* Override RichTextInput so the box provides the border */
  --rich-input-border: none;
  --rich-input-bg: transparent;
  --rich-input-radius: 0;
}

.chat-composer:focus-within {
  border-color: var(--color-accent);
}

.chat-composer-files {
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--color-border);
}

.chat-composer-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px 6px;
}

.chat-composer-btn {
  display: flex;
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

.chat-composer-btn:hover:not(:disabled) {
  background: var(--color-hover);
  color: var(--color-text);
}

.chat-composer-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}


.chat-composer-spacer {
  flex: 1;
}

.chat-composer-send {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--color-accent);
  border: none;
  color: #fff;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.15s;
}

.chat-composer-send:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.chat-composer-send:not(:disabled):hover {
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

/* ── Note selection chips in sent messages ── */

.chat-msg-selections {
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

/* ── Drop error ── */

.chat-drop-error {
  font-size: 11px;
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  border-radius: 4px;
  padding: 5px 10px;
  margin: 0 8px;
}


/* ── Fallback warning ── */

.chat-fallback-warning {
  font-size: 10.5px;
  color: var(--color-text-muted);
  font-style: italic;
  padding: 2px 4px;
  opacity: 0.75;
}
</style>
