<script lang="ts">
// Module-level: persists showRelatedPanel state per noteId across component
// unmounts/remounts (e.g. tab switches) and noteId changes within the same instance.
const relatedPanelState = new Map<string, boolean>()
export {}
</script>

<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useEditor, EditorContent, VueRenderer, VueNodeViewRenderer } from '@tiptap/vue-3'
import Mention from '@tiptap/extension-mention'
import StarterKit from '@tiptap/starter-kit'
import { Extension } from '@tiptap/core'
import Suggestion from '@tiptap/suggestion'
import MentionList from './MentionList.vue'
import MentionChip from './MentionChip.vue'
import SlashCommandList from './SlashCommandList.vue'
import type { SlashCommandItem } from './SlashCommandList.vue'
import TrashedMentionPopup from './TrashedMentionPopup.vue'
import type { MentionItem } from './MentionList.vue'
import type { SuggestionProps, SuggestionKeyDownProps } from '@tiptap/suggestion'
import EntityMentionPopup from './EntityMentionPopup.vue'
import NoteLinkList from './NoteLinkList.vue'
import NoteLinkChip from './NoteLinkChip.vue'
import NoteLinkPopup from './NoteLinkPopup.vue'
import TrashedNoteLinkPopup from './TrashedNoteLinkPopup.vue'
import type { NoteLinkItem } from './NoteLinkList.vue'
import {
  entityTrashStatus,
  registerMentionClickHandler,
} from '../stores/mentionStore'
import {
  noteArchivedStatus,
  registerNoteLinkClickHandler,
} from '../stores/noteLinkStore'
import type { OpenMode } from '../stores/tabStore'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { Underline } from '@tiptap/extension-underline'
import { Highlight } from '@tiptap/extension-highlight'
import { Superscript } from '@tiptap/extension-superscript'
import { Subscript } from '@tiptap/extension-subscript'
import { TextAlign } from '@tiptap/extension-text-align'
import { Link } from '@tiptap/extension-link'
import { Image as TiptapImage } from '@tiptap/extension-image'
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import ActionTaskItem from './ActionTaskItem.vue'
import { setCurrentNoteId, registerPromoteHandler } from '../stores/taskActionStore'
import ToolbarDropdown from './ToolbarDropdown.vue'
import AutoMentionPopup from './AutoMentionPopup.vue'
import { AutoMentionDecoration } from '../extensions/AutoMentionDecoration'
import type { AutoDetection } from '../extensions/AutoMentionDecoration'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import { isInTable, CellSelection } from '@tiptap/pm/tables'
import TableContextMenu from './TableContextMenu.vue'
import {
  hoveredAutoDetection,
  scheduleHideAutoDetection,
} from '../stores/autoMentionStore'
import {
  Undo2, Redo2,
  Pilcrow, Heading1, Heading2, Heading3,
  List, ListOrdered, ListTodo,
  Quote, Braces,
  Bold, Italic, Strikethrough, Code, Link2,
  Underline as UnderlineIcon,
  Highlighter,
  Superscript as SuperscriptIcon,
  Subscript as SubscriptIcon,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  RemoveFormatting,
  ImagePlus,
  Check, ExternalLink, Trash2,
  Palette,
  Mic, MicOff, ChevronDown as ChevronDownIcon,
  ScrollText, X, Sparkles, Table2,
} from 'lucide-vue-next'
import {
  pendingAutoStartNoteId,
  activeTranscriptionNoteId,
  activeAudio,
} from '../stores/transcriptionStore'

const props = defineProps<{ noteId: string }>()
const emit = defineEmits<{
  saved: [title: string]
  loaded: [title: string]
  'open-entity': [{ entityId: string; typeId: string; mode: OpenMode }]
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

type NoteRow = {
  id: string
  title: string
  body: string
  body_plain: string
}

const TEXT_COLORS = [
  { name: 'Red',    value: '#ef4444' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Green',  value: '#22c55e' },
  { name: 'Blue',   value: '#5b8def' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Pink',   value: '#ec4899' },
  { name: 'Muted',  value: '#888888' },
]

const title = ref('Untitled')
const saveStatus = ref<'saved' | 'saving' | 'unsaved'>('saved')

// ── Meeting context (when this note is a meeting note) ─────────────────────────

type LinkedCalendarEvent = {
  id: number
  title: string
  start_at: string
  end_at: string
  attendees: string // JSON string
}

const linkedCalendarEvent = ref<LinkedCalendarEvent | null>(null)

const parsedAttendees = computed(() => {
  if (!linkedCalendarEvent.value?.attendees) return []
  try {
    return JSON.parse(linkedCalendarEvent.value.attendees) as Array<{ name: string; email: string }>
  } catch {
    return []
  }
})

function formatMeetingTime(ev: LinkedCalendarEvent): string {
  const start = new Date(ev.start_at)
  const end = new Date(ev.end_at)
  const date = start.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
  const startTime = start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const endTime = end.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  return `${date} · ${startTime} – ${endTime}`
}

// ── Transcription state ────────────────────────────────────────────────────────

const isTranscribing = ref(false)
const transcriptText = ref('')      // finalized partial transcripts accumulated
const transcriptPartial = ref('')   // current non-final partial (shown while streaming)
const transcriptionError = ref<string | null>(null)

// Audio capture objects live in activeAudio (module scope) so they persist
// across NoteEditor unmounts — see transcriptionStore.ts.

/** True when a different note is currently being transcribed. */
const isAnotherNoteTranscribing = computed(
  () => activeTranscriptionNoteId.value !== null && activeTranscriptionNoteId.value !== props.noteId,
)

// ── Stored transcription sessions ─────────────────────────────────────────────

interface StoredTranscription {
  id: string
  note_id: string
  started_at: string
  ended_at: string | null
  raw_transcript: string
  summary: string
}

const storedTranscriptions = ref<StoredTranscription[]>([])
const expandedTranscriptIds = ref<string[]>([])
const showTranscriptPanel = ref(false)
const backlinks = ref<{ id: string; title: string }[]>([])
const showBacklinks = ref(false)
const pendingDeleteTranscriptId = ref<string | null>(null)

// ── Related notes panel ────────────────────────────────────────────────────────

const showRelatedPanel = ref(relatedPanelState.get(props.noteId) ?? false)
const relatedNotes = ref<{ id: string; title: string; excerpt: string | null }[]>([])
const isLoadingRelated = ref(false)

async function loadRelatedNotes(): Promise<void> {
  const query = [title.value, editor.value?.getText()?.slice(0, 500)]
    .filter(Boolean).join(' ').trim()
  if (!query) return
  isLoadingRelated.value = true
  try {
    const results = (await window.api.invoke('notes:semantic-search', { query })) as {
      id: string; title: string; excerpt: string | null
    }[]
    relatedNotes.value = results.filter((r) => r.id !== props.noteId).slice(0, 7)
  } finally {
    isLoadingRelated.value = false
  }
}

function onOpenRelatedNote(e: MouseEvent, id: string, noteTitle: string): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: id, title: noteTitle, mode })
}

watch(showRelatedPanel, (val) => {
  relatedPanelState.set(props.noteId, val)
  if (val && relatedNotes.value.length === 0) void loadRelatedNotes()
})

/** Last ~120 chars of the live stream — shown in the status bar while recording. */
const lastTranscriptLine = computed(() => {
  if (transcriptPartial.value) return transcriptPartial.value.slice(-120)
  const full = transcriptText.value.trim()
  if (!full) return ''
  return full.length > 120 ? '…' + full.slice(-120) : full
})

async function loadBacklinks(noteId: string): Promise<void> {
  backlinks.value = (await window.api.invoke('notes:get-backlinks', {
    id: noteId,
  })) as { id: string; title: string }[]
}

function onOpenBacklink(e: MouseEvent, id: string, noteTitle: string): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: id, title: noteTitle, mode })
}

async function loadTranscriptions(): Promise<void> {
  storedTranscriptions.value = []
  const result = await window.api.invoke('transcriptions:list', { noteId: props.noteId })
  storedTranscriptions.value = result as StoredTranscription[]
  // Auto-expand the most recent session
  if (storedTranscriptions.value.length > 0 && expandedTranscriptIds.value.length === 0) {
    expandedTranscriptIds.value = [storedTranscriptions.value[0].id]
  }
}

function toggleTranscript(id: string): void {
  const idx = expandedTranscriptIds.value.indexOf(id)
  if (idx >= 0) {
    expandedTranscriptIds.value.splice(idx, 1)
  } else {
    expandedTranscriptIds.value.push(id)
  }
}

async function deleteTranscription(id: string): Promise<void> {
  if (pendingDeleteTranscriptId.value !== id) {
    // First click: arm the confirm state
    pendingDeleteTranscriptId.value = id
    return
  }
  // Second click: confirmed — delete
  pendingDeleteTranscriptId.value = null
  await window.api.invoke('transcriptions:delete', { id })
  storedTranscriptions.value = storedTranscriptions.value.filter((t) => t.id !== id)
  expandedTranscriptIds.value = expandedTranscriptIds.value.filter((x) => x !== id)
}

function formatTranscriptTime(startedAt: string, endedAt: string | null): string {
  const start = new Date(startedAt)
  const dateStr = start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const timeStr = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (!endedAt) return `${dateStr}, ${timeStr}`
  const durationMs = new Date(endedAt).getTime() - start.getTime()
  const mins = Math.round(durationMs / 60000)
  return `${dateStr}, ${timeStr} · ${mins} min`
}

async function startTranscription(): Promise<void> {
  if (!linkedCalendarEvent.value) return
  // Block if a different note is already being transcribed
  if (isAnotherNoteTranscribing.value) {
    transcriptionError.value = 'Another note is currently being transcribed'
    return
  }
  transcriptionError.value = null

  const result = (await window.api.invoke('transcription:start', {
    noteId: props.noteId,
    eventId: linkedCalendarEvent.value.id,
  })) as { ok: boolean; audioFormat?: string; error?: string }

  if (!result.ok) {
    transcriptionError.value = result.error ?? 'Failed to start transcription'
    return
  }

  activeTranscriptionNoteId.value = props.noteId
  activeAudio.format = result.audioFormat ?? null

  // audioFormat:'none' = Swift captures directly; 'system-audio' = AudioCapture.app handles it
  if (result.audioFormat === 'none' || result.audioFormat === 'system-audio') {
    isTranscribing.value = true
    transcriptText.value = ''
    transcriptPartial.value = ''
    return
  }

  try {
    activeAudio.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })

    if (result.audioFormat === 'pcm') {
      // ElevenLabs: capture raw PCM Int16 at 16kHz via ScriptProcessorNode
      activeAudio.context = new AudioContext({ sampleRate: 16000 })
      const source = activeAudio.context.createMediaStreamSource(activeAudio.mediaStream)
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      activeAudio.scriptProcessor = activeAudio.context.createScriptProcessor(4096, 1, 1)
      source.connect(activeAudio.scriptProcessor)
      activeAudio.scriptProcessor.connect(activeAudio.context.destination)
      activeAudio.scriptProcessor.onaudioprocess = (e) => {
        const f32 = e.inputBuffer.getChannelData(0)
        const i16 = new Int16Array(f32.length)
        for (let i = 0; i < f32.length; i++) {
          i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32768)))
        }
        window.api.send('transcription:audio-chunk', i16.buffer)
      }
    } else {
      // Deepgram: stream WebM/Opus via MediaRecorder
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      activeAudio.mediaRecorder = new MediaRecorder(activeAudio.mediaStream, { mimeType })
      activeAudio.mediaRecorder.ondataavailable = async (e: BlobEvent) => {
        if (e.data.size === 0) return
        const buf = await e.data.arrayBuffer()
        window.api.send('transcription:audio-chunk', buf)
      }
      activeAudio.mediaRecorder.start(250) // 250ms chunks
    }

    isTranscribing.value = true
    transcriptText.value = ''
    transcriptPartial.value = ''
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Microphone access denied'
    transcriptionError.value = msg
    activeTranscriptionNoteId.value = null
    activeAudio.format = null
    void window.api.invoke('transcription:stop')
  }
}

async function stopTranscription(): Promise<void> {
  // ElevenLabs path cleanup
  activeAudio.scriptProcessor?.disconnect()
  activeAudio.scriptProcessor = null
  await activeAudio.context?.close()
  activeAudio.context = null
  // Deepgram path cleanup
  activeAudio.mediaRecorder?.stop()
  activeAudio.mediaStream?.getTracks().forEach((t) => t.stop())
  activeAudio.mediaRecorder = null
  activeAudio.mediaStream = null
  activeAudio.format = null
  activeTranscriptionNoteId.value = null
  isTranscribing.value = false
  await window.api.invoke('transcription:stop')
}

const unsubTranscriptPartial = window.api.on('transcription:partial', (...args: unknown[]) => {
  const { text, isFinal } = args[0] as { text: string; isFinal: boolean }
  if (isFinal) {
    transcriptText.value += (transcriptText.value ? ' ' : '') + text
    transcriptPartial.value = ''
  } else {
    transcriptPartial.value = text
  }
})

const unsubTranscriptComplete = window.api.on('transcription:complete', (...args: unknown[]) => {
  const { noteId } = args[0] as { noteId: string }
  if (noteId === props.noteId) {
    transcriptText.value = ''
    transcriptPartial.value = ''
    activeTranscriptionNoteId.value = null
    activeAudio.format = null
    // Expand the incoming session when it loads; open the side panel
    expandedTranscriptIds.value = []
    showTranscriptPanel.value = true
    void loadNote(props.noteId)  // also calls loadTranscriptions() at the end
  }
})

const unsubTranscriptError = window.api.on('transcription:error', (...args: unknown[]) => {
  const { message } = args[0] as { message: string }
  transcriptionError.value = message
  isTranscribing.value = false
  if (activeTranscriptionNoteId.value === props.noteId) {
    activeTranscriptionNoteId.value = null
    activeAudio.format = null
  }
})

// Loading state while /action slash command calls Claude to extract actions
const isExtractingActions = ref(false)

const showLinkPopup = ref(false)
const linkInputValue = ref('')
const tableContextMenu = ref<{ x: number; y: number } | null>(null)
const linkInputRef = ref<HTMLInputElement | null>(null)
const linkPopupRef = ref<HTMLElement | null>(null)

const showDatePicker = ref(false)
const datePickerValue = ref('')
const datePickerInputRef = ref<HTMLInputElement | null>(null)
const datePickerPopupRef = ref<HTMLDivElement | null>(null)

type AutoDetectionRow = {
  entity_id: string
  entity_name: string
  type_id: string
  type_name: string
  type_icon: string
  type_color: string | null
  confidence: number
}

let savedFrom = 0
let savedTo = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null
let isLoading = false

// Immediately refresh decorations when the NER pipeline completes.
// The main process pushes 'note:ner-complete' as soon as runNer() finishes,
// so there is no fixed polling delay — decorations appear within ~2-4s of saving.
const unsubscribeNer = window.api.on('note:ner-complete', (...args: unknown[]) => {
  const payload = args[0] as { noteId: string }
  if (payload.noteId === props.noteId) {
    void fetchAndSetAutoDetections(payload.noteId)
  }
})

const popupEntityId = ref<string | null>(null)
const popupAnchorRect = ref<DOMRect | null>(null)

const popupNoteId = ref<string | null>(null)
const popupNoteAnchorRect = ref<DOMRect | null>(null)

registerMentionClickHandler((id, rect) => {
  popupEntityId.value = id
  popupAnchorRect.value = rect
})

registerNoteLinkClickHandler((id, rect) => {
  popupNoteId.value = id
  popupNoteAnchorRect.value = rect
})

function buildMentionSuggestion() {
  return {
    items: async ({ query }: { query: string }): Promise<MentionItem[]> => {
      return (await window.api.invoke('entities:search', { query })) as MentionItem[]
    },
    render: () => {
      let renderer: VueRenderer
      let el: HTMLDivElement

      function positionEl(rect: DOMRect | null | undefined) {
        if (!el || !rect) return
        el.style.top = `${rect.bottom + 4}px`
        el.style.left = `${rect.left}px`
      }

      return {
        onStart: (props: SuggestionProps<MentionItem>) => {
          el = document.createElement('div')
          el.style.cssText = 'position:fixed;z-index:9999'
          document.body.appendChild(el)
          renderer = new VueRenderer(MentionList, { props, editor: props.editor })
          if (renderer.element) el.appendChild(renderer.element)
          positionEl(props.clientRect?.())
        },
        onUpdate: (props: SuggestionProps<MentionItem>) => {
          renderer?.updateProps(props)
          positionEl(props.clientRect?.())
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
          if (event.key === 'Escape') {
            el?.remove()
            renderer?.destroy()
            return true
          }
          return (renderer?.ref as { onKeyDown?: (e: KeyboardEvent) => boolean })?.onKeyDown?.(event) ?? false
        },
        onExit: () => {
          el?.remove()
          renderer?.destroy()
        },
      }
    },
  }
}

function buildNoteLinkSuggestion() {
  return {
    char: '[[',
    allowSpaces: true,
    items: async ({ query }: { query: string }): Promise<NoteLinkItem[]> => {
      return (await window.api.invoke('notes:search', { query })) as NoteLinkItem[]
    },
    render: () => {
      let renderer: VueRenderer
      let el: HTMLDivElement

      function positionEl(rect: DOMRect | null | undefined) {
        if (!el || !rect) return
        el.style.top = `${rect.bottom + 4}px`
        el.style.left = `${rect.left}px`
      }

      return {
        onStart: (props: SuggestionProps<NoteLinkItem>) => {
          el = document.createElement('div')
          el.style.cssText = 'position:fixed;z-index:9999'
          document.body.appendChild(el)
          renderer = new VueRenderer(NoteLinkList, { props, editor: props.editor })
          if (renderer.element) el.appendChild(renderer.element)
          positionEl(props.clientRect?.())
        },
        onUpdate: (props: SuggestionProps<NoteLinkItem>) => {
          renderer?.updateProps(props)
          positionEl(props.clientRect?.())
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
          if (event.key === 'Escape') {
            el?.remove()
            renderer?.destroy()
            return true
          }
          return (renderer?.ref as { onKeyDown?: (e: KeyboardEvent) => boolean })?.onKeyDown?.(event) ?? false
        },
        onExit: () => {
          el?.remove()
          renderer?.destroy()
        },
      }
    },
  }
}

const SLASH_COMMANDS: SlashCommandItem[] = [
  { id: 'action', label: 'Extract action items', description: 'AI-extract tasks and insert as a list', icon: 'sparkles' },
  { id: 'date', label: 'Insert date', description: 'Pick a date to insert at cursor', icon: 'calendar' },
]

async function extractAndInsertActions(
  ed: { chain(): { focus(): { insertContent(c: unknown): { run(): void } } } },
  bodyPlain: string
): Promise<void> {
  isExtractingActions.value = true
  try {
    const result = (await window.api.invoke('notes:extract-actions', { body_plain: bodyPlain })) as {
      heading: string
      items: string[]
    }
    if (!result.items.length) return
    ed.chain().focus().insertContent([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: result.heading }] },
      {
        type: 'taskList',
        content: result.items.map((t) => ({
          type: 'taskItem',
          attrs: { checked: false, actionId: null },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
        })),
      },
    ]).run()
  } finally {
    isExtractingActions.value = false
  }
}

function openDatePicker(): void {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  datePickerValue.value = `${yyyy}-${mm}-${dd}`
  showDatePicker.value = true
  nextTick(() => {
    datePickerInputRef.value?.focus()
    datePickerInputRef.value?.showPicker?.()
  })
}

function confirmDate(): void {
  if (!datePickerValue.value || !editor.value) { closeDatePicker(); return }
  const [yyyy, mm, dd] = datePickerValue.value.split('-').map(Number)
  const formatted = new Date(yyyy, mm - 1, dd).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  })
  editor.value.chain().focus().insertContent(formatted).run()
  closeDatePicker()
}

function closeDatePicker(): void {
  showDatePicker.value = false
}

function onDatePickerOutside(e: MouseEvent): void {
  if (datePickerPopupRef.value && !datePickerPopupRef.value.contains(e.target as Node)) {
    closeDatePicker()
  }
}

watch(showDatePicker, (open) => {
  if (open) {
    document.addEventListener('mousedown', onDatePickerOutside)
  } else {
    document.removeEventListener('mousedown', onDatePickerOutside)
  }
})

function buildSlashCommandSuggestion() {
  return {
    char: '/',
    allowSpaces: false,
    startOfLine: false,
    items: ({ query }: { query: string }): SlashCommandItem[] =>
      SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(query.toLowerCase())),
    command: ({ editor: ed, range, props: item }: { editor: { chain(): { focus(): { deleteRange(r: { from: number; to: number }): { run(): void } } } }; range: { from: number; to: number }; props: SlashCommandItem }) => {
      ed.chain().focus().deleteRange(range).run()
      if (item.id === 'action') {
        const bodyPlain = (editor.value?.getText()) ?? ''
        void extractAndInsertActions(
          ed as unknown as { chain(): { focus(): { insertContent(c: unknown): { run(): void } } } },
          bodyPlain
        )
      } else if (item.id === 'date') {
        openDatePicker()
      }
    },
    render: () => {
      let renderer: VueRenderer
      let el: HTMLDivElement

      function positionEl(rect: DOMRect | null | undefined) {
        if (!el || !rect) return
        el.style.top = `${rect.bottom + 4}px`
        el.style.left = `${rect.left}px`
      }

      return {
        onStart: (p: SuggestionProps<SlashCommandItem>) => {
          el = document.createElement('div')
          el.style.cssText = 'position:fixed;z-index:9999'
          document.body.appendChild(el)
          renderer = new VueRenderer(SlashCommandList, { props: p, editor: p.editor })
          if (renderer.element) el.appendChild(renderer.element)
          positionEl(p.clientRect?.())
        },
        onUpdate: (p: SuggestionProps<SlashCommandItem>) => {
          renderer?.updateProps(p)
          positionEl(p.clientRect?.())
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
          if (event.key === 'Escape') { el?.remove(); renderer?.destroy(); return true }
          return (renderer?.ref as { onKeyDown?: (e: KeyboardEvent) => boolean })?.onKeyDown?.(event) ?? false
        },
        onExit: () => { el?.remove(); renderer?.destroy() },
      }
    },
  }
}

const SlashCommandExtension = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...buildSlashCommandSuggestion() })]
  },
})

const editor = useEditor({
  extensions: [
    StarterKit,
    Placeholder.configure({ placeholder: 'Start writing…' }),
    TextStyle,
    Color,
    Underline,
    Highlight.configure({ multicolor: false }),
    Superscript,
    Subscript,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Link.configure({ openOnClick: false }),
    TiptapImage,
    TaskList,
    TaskItem.extend({
      addAttributes() {
        return {
          ...this.parent?.(),
          actionId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-action-id') ?? null,
            renderHTML: (attrs) => (attrs.actionId ? { 'data-action-id': attrs.actionId } : {}),
          },
        }
      },
      addNodeView() {
        return VueNodeViewRenderer(ActionTaskItem)
      },
    }).configure({ nested: true }),
    Mention.extend({
      addNodeView() {
        return VueNodeViewRenderer(MentionChip)
      },
    }).configure({
      suggestion: buildMentionSuggestion(),
    }),
    Mention.extend({
      name: 'noteLink',
      addNodeView() {
        return VueNodeViewRenderer(NoteLinkChip)
      },
    }).configure({
      suggestion: buildNoteLinkSuggestion(),
    }),
    AutoMentionDecoration,
    SlashCommandExtension,
    Table.configure({ resizable: true }),
    TableRow,
    TableHeader,
    TableCell,
  ],
  content: { type: 'doc', content: [] },
  onUpdate() {
    scheduleSave()
  },
})

const headingIcon = computed(() => {
  if (!editor.value) return Pilcrow
  if (editor.value.isActive('heading', { level: 1 })) return Heading1
  if (editor.value.isActive('heading', { level: 2 })) return Heading2
  if (editor.value.isActive('heading', { level: 3 })) return Heading3
  return Pilcrow
})

const isHeadingActive = computed(
  () =>
    editor.value?.isActive('heading', { level: 1 }) ||
    editor.value?.isActive('heading', { level: 2 }) ||
    editor.value?.isActive('heading', { level: 3 }) ||
    false
)

const isListActive = computed(
  () =>
    editor.value?.isActive('bulletList') ||
    editor.value?.isActive('orderedList') ||
    editor.value?.isActive('taskList') ||
    false
)

function scheduleSave(): void {
  if (isLoading) return
  saveStatus.value = 'unsaved'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(flushSave, 500)
}

async function flushSave(overrideId?: string): Promise<void> {
  saveTimer = null
  if (!editor.value) return
  const id = overrideId ?? props.noteId
  saveStatus.value = 'saving'
  try {
    await window.api.invoke('notes:update', {
      id,
      title: title.value || 'Untitled',
      body: JSON.stringify(editor.value.getJSON()),
      body_plain: editor.value.getText(),
    })
    saveStatus.value = 'saved'
    emit('saved', title.value || 'Untitled')
    if (showRelatedPanel.value) void loadRelatedNotes()
  } catch {
    saveStatus.value = 'unsaved'
  }
}

async function fetchAndSetAutoDetections(noteId: string): Promise<void> {
  if (!editor.value) return
  const rows = (await window.api.invoke('notes:get-auto-detections', {
    id: noteId,
  })) as AutoDetectionRow[]
  const detections: AutoDetection[] = rows.map((r) => ({
    entityId: r.entity_id,
    entityName: r.entity_name,
    typeId: r.type_id,
    typeName: r.type_name,
    typeIcon: r.type_icon,
    typeColor: r.type_color,
    confidence: r.confidence,
  }))
  editor.value.commands.setAutoDetections(detections)
}

async function loadNote(noteId: string): Promise<void> {
  isLoading = true
  saveStatus.value = 'saved'
  try {
    const [note, calEvent] = await Promise.all([
      window.api.invoke('notes:get', { id: noteId }) as Promise<NoteRow | null>,
      window.api.invoke('calendar-events:get-by-note', { note_id: noteId }) as Promise<LinkedCalendarEvent | null>,
    ])
    linkedCalendarEvent.value = calEvent
    if (!note || !editor.value) return
    title.value = note.title
    setCurrentNoteId(noteId)
    let content: object = { type: 'doc', content: [] }
    try {
      if (note.body && note.body !== '{}') {
        content = JSON.parse(note.body) as object
      }
    } catch {
      // malformed body — use empty doc
    }
    editor.value.commands.setContent(content)

    // Fetch trash status for all entities mentioned in this note
    const mentionIds = extractMentionIdsFromBody(note.body)
    if (mentionIds.length > 0) {
      const statusMap = (await window.api.invoke('entities:get-trash-status', {
        ids: mentionIds,
      })) as Record<string, boolean>
      for (const [id, trashed] of Object.entries(statusMap)) {
        entityTrashStatus.set(id, trashed)
      }
    }

    // Fetch archived status for all note-links in this note
    const noteLinkIds = extractNoteLinkIdsFromBody(note.body)
    if (noteLinkIds.length > 0) {
      const archivedMap = (await window.api.invoke('notes:get-archived-status', {
        ids: noteLinkIds,
      })) as Record<string, boolean>
      for (const [id, archived] of Object.entries(archivedMap)) {
        noteArchivedStatus.set(id, archived)
      }
    }
  } finally {
    await nextTick()
    isLoading = false
  }
  emit('loaded', title.value || 'Untitled')
  // Load NER-detected entity mentions for decoration hints
  void fetchAndSetAutoDetections(noteId)
  // Reconcile task-item checked states against live action item statuses
  void syncTaskItemsWithDB()
  // Load all transcription sessions for this note
  void loadTranscriptions()
  // Load backlinks (other notes that [[link]] to this one)
  showBacklinks.value = false
  void loadBacklinks(noteId)
  // Reset related notes — will reload if panel is open
  relatedNotes.value = []
  if (showRelatedPanel.value) void loadRelatedNotes()
}

function extractMentionIdsFromBody(bodyJson: string): string[] {
  let doc: unknown
  try {
    doc = JSON.parse(bodyJson)
  } catch {
    return []
  }
  const ids: string[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n['type'] === 'mention' && n['attrs'] && typeof n['attrs'] === 'object') {
      const id = (n['attrs'] as Record<string, unknown>)['id']
      if (typeof id === 'string' && id) ids.push(id)
    }
    if (Array.isArray(n['content'])) {
      for (const child of n['content']) walk(child)
    }
  }
  walk(doc)
  return ids
}

function extractNoteLinkIdsFromBody(bodyJson: string): string[] {
  let doc: unknown
  try {
    doc = JSON.parse(bodyJson)
  } catch {
    return []
  }
  const ids: string[] = []
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (n['type'] === 'noteLink' && n['attrs'] && typeof n['attrs'] === 'object') {
      const id = (n['attrs'] as Record<string, unknown>)['id']
      if (typeof id === 'string' && id) ids.push(id)
    }
    if (Array.isArray(n['content'])) {
      for (const child of n['content']) walk(child)
    }
  }
  walk(doc)
  return ids
}

function setLink(): void {
  if (!editor.value) return
  const { from, to, empty } = editor.value.state.selection
  const isInLink = editor.value.isActive('link')
  if (empty && !isInLink) return

  savedFrom = from
  savedTo = to
  const existing = editor.value.getAttributes('link').href as string | undefined
  linkInputValue.value = existing ?? ''
  showLinkPopup.value = true
  nextTick(() => linkInputRef.value?.focus())
}

function confirmLink(): void {
  if (!editor.value) return
  const url = linkInputValue.value.trim()
  closeLinkPopup()
  if (url === '') {
    editor.value.chain().focus().setTextSelection({ from: savedFrom, to: savedTo }).extendMarkRange('link').unsetLink().run()
  } else {
    editor.value.chain().focus().setTextSelection({ from: savedFrom, to: savedTo }).extendMarkRange('link').setLink({ href: url }).run()
  }
}

function removeLinkAndClose(): void {
  if (!editor.value) return
  closeLinkPopup()
  editor.value.chain().focus().setTextSelection({ from: savedFrom, to: savedTo }).extendMarkRange('link').unsetLink().run()
}

function openLink(): void {
  const url = linkInputValue.value.trim() || (editor.value?.getAttributes('link').href as string | undefined)
  if (url) window.open(url, '_blank')
}

function closeLinkPopup(): void {
  showLinkPopup.value = false
  linkInputValue.value = ''
}

function onLinkPopupOutside(e: MouseEvent): void {
  if (linkPopupRef.value && !linkPopupRef.value.contains(e.target as Node)) {
    closeLinkPopup()
  }
}

watch(showLinkPopup, (open) => {
  if (open) {
    document.addEventListener('mousedown', onLinkPopupOutside)
  } else {
    document.removeEventListener('mousedown', onLinkPopupOutside)
  }
})

function insertImage(): void {
  const url = window.prompt('Enter image URL')
  if (url) {
    editor.value?.chain().focus().setImage({ src: url }).run()
  }
}

function insertTable(): void {
  editor.value?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
}

function onNoteBodyMouseDown(e: MouseEvent): void {
  // Prevent the browser from collapsing a CellSelection when right-clicking.
  // Without this, the browser moves the DOM cursor to the click position on
  // mousedown, ProseMirror syncs its state, and CellSelection is lost before
  // the contextmenu event fires — making merge/split options invisible.
  if (e.button !== 2 || !editor.value) return
  if (editor.value.state.selection instanceof CellSelection) {
    e.preventDefault()
  }
}

function onEditorContextMenu(e: MouseEvent): void {
  if (!editor.value || !isInTable(editor.value.state)) return
  e.preventDefault()
  e.stopPropagation()
  tableContextMenu.value = { x: e.clientX, y: e.clientY }
}

function closeTableContextMenu(): void {
  tableContextMenu.value = null
}

function onInsertAutoMention(payload: {
  entityId: string
  entityName: string
  from: number
  to: number
}): void {
  if (!editor.value) return
  editor.value
    .chain()
    .focus()
    .deleteRange({ from: payload.from, to: payload.to })
    .insertContentAt(payload.from, {
      type: 'mention',
      attrs: { id: payload.entityId, label: payload.entityName },
    })
    .run()
  scheduleHideAutoDetection(0)
}

// Register the promote handler — called when the ActionTaskItem "Add to dashboard" button is clicked.
// Uses the module-level store so the NodeView (which runs outside Vue's component tree) can call it.
registerPromoteHandler(async (taskText: string, pos: number) => {
  const created = (await window.api.invoke('action-items:create', {
    title: taskText,
    source_note_id: props.noteId,
    extraction_type: 'manual',
  })) as { id: string }
  if (!editor.value) return
  const { state, view } = editor.value
  const tr = state.tr
  state.doc.descendants((node, nodePos) => {
    if (node.type.name === 'taskItem' && nodePos === pos) {
      tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, actionId: created.id })
      return false
    }
    return true
  })
  view.dispatch(tr)
  scheduleSave()
})

// Sync task item checked state when an action item's status changes from the dashboard.
const unsubscribeActionStatus = window.api.on('action:status-changed', (...args: unknown[]) => {
  const { actionId, status } = args[0] as { actionId: string; status: string }
  syncTaskItemChecked(actionId, status === 'done')
})

// Clear the actionId attribute on the linked task item when the action is deleted from the dashboard.
const unsubscribeActionUnlinked = window.api.on('action:unlinked', (...args: unknown[]) => {
  const { actionId, noteId } = args[0] as { actionId: string; noteId: string }
  if (noteId !== props.noteId || !editor.value) return
  const { state, view } = editor.value
  const tr = state.tr
  let found = false
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && node.attrs.actionId === actionId) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, actionId: null })
      found = true
      return false
    }
    return true
  })
  if (found) {
    view.dispatch(tr)
    scheduleSave()
  }
})

// Called after every loadNote to reconcile task-item checked states with the DB.
// Handles the case where the user changed action statuses in the dashboard while
// the note was not mounted (NoteEditor unmounted → push event was never received).
async function syncTaskItemsWithDB(): Promise<void> {
  if (!editor.value) return
  const linked: { pos: number; actionId: string; checked: boolean }[] = []
  editor.value.state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && node.attrs.actionId) {
      linked.push({ pos, actionId: node.attrs.actionId as string, checked: node.attrs.checked as boolean })
    }
    return true
  })
  if (!linked.length) return
  const statuses = (await window.api.invoke('action-items:get-statuses', {
    ids: linked.map((l) => l.actionId),
  })) as Record<string, string>
  const { state, view } = editor.value
  const tr = state.tr
  let changed = false
  for (const { pos, actionId, checked } of linked) {
    const shouldBeChecked = statuses[actionId] === 'done'
    if (shouldBeChecked !== checked) {
      const node = state.doc.nodeAt(pos)
      if (node) {
        tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: shouldBeChecked })
        changed = true
      }
    }
  }
  if (changed) {
    view.dispatch(tr)
    scheduleSave()
  }
}

function syncTaskItemChecked(actionId: string, checked: boolean): void {
  if (!editor.value) return
  const { state, view } = editor.value
  const tr = state.tr
  let found = false
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && node.attrs.actionId === actionId) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked })
      found = true
      return false
    }
    return true
  })
  if (found) {
    view.dispatch(tr)
    scheduleSave()
  }
}

watch(
  () => props.noteId,
  async (newId, oldId) => {
    if (saveTimer && oldId) {
      clearTimeout(saveTimer)
      saveTimer = null
      if (editor.value) {
        await window.api.invoke('notes:update', {
          id: oldId,
          title: title.value || 'Untitled',
          body: JSON.stringify(editor.value.getJSON()),
          body_plain: editor.value.getText(),
        })
      }
    }
    showRelatedPanel.value = relatedPanelState.get(newId) ?? false
    await loadNote(newId)
    // Reconnect to an ongoing transcription session when returning to this note
    if (activeTranscriptionNoteId.value === newId) {
      const status = (await window.api.invoke('transcription:status')) as {
        isTranscribing: boolean
        noteId: string | null
      }
      if (status.isTranscribing && status.noteId === newId) {
        isTranscribing.value = true
      } else {
        // Session ended while we were away — clean up store
        activeTranscriptionNoteId.value = null
        activeAudio.format = null
      }
    }
    // Auto-start transcription if triggered via meeting prompt
    if (pendingAutoStartNoteId.value === newId) {
      pendingAutoStartNoteId.value = null
      void startTranscription()
    }
  },
  { immediate: true }
)

watch(title, scheduleSave)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onLinkPopupOutside)
  document.removeEventListener('mousedown', onDatePickerOutside)
  unsubscribeNer()
  unsubscribeActionStatus()
  unsubscribeActionUnlinked()
  unsubTranscriptPartial()
  unsubTranscriptComplete()
  unsubTranscriptError()
  // If transcription is active we intentionally do NOT stop it here.
  // Audio objects live in activeAudio (module scope) and keep streaming to the
  // main-process WebSocket while the user is on another note or view.
  if (saveTimer) {
    clearTimeout(saveTimer)
    flushSave()
  }
  editor.value?.destroy()
})
</script>

<template>
  <div class="note-editor">
    <div class="note-header">
      <input
        v-model="title"
        class="note-title"
        type="text"
        placeholder="Untitled"
        spellcheck="false"
      />
      <span class="save-status" :data-status="saveStatus">
        {{ saveStatus === 'saving' ? 'Saving…' : saveStatus === 'unsaved' ? 'Unsaved' : '' }}
      </span>
      <button
        class="related-notes-toggle-btn"
        :class="{ active: showRelatedPanel }"
        title="Related notes"
        @click="showRelatedPanel = !showRelatedPanel"
      >
        <Sparkles :size="13" />
      </button>
    </div>

    <!-- Formatting toolbar -->
    <div class="format-toolbar">

      <!-- History -->
      <div class="tb-group">
        <button class="tb-btn" title="Undo (Cmd+Z)" @click="editor?.chain().focus().undo().run()">
          <Undo2 :size="14" />
        </button>
        <button class="tb-btn" title="Redo (Cmd+Shift+Z)" @click="editor?.chain().focus().redo().run()">
          <Redo2 :size="14" />
        </button>
      </div>

      <div class="tb-sep" />

      <!-- Heading dropdown -->
      <ToolbarDropdown :active="isHeadingActive">
        <template #label><component :is="headingIcon" :size="13" /></template>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('paragraph') && !editor?.isActive('heading') }"
          @click="editor?.chain().focus().setParagraph().run()"
        >
          <Pilcrow :size="14" class="tb-di-svg" />Paragraph
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('heading', { level: 1 }) }"
          @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
        >
          <Heading1 :size="14" class="tb-di-svg" />Heading 1
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('heading', { level: 2 }) }"
          @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          <Heading2 :size="14" class="tb-di-svg" />Heading 2
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('heading', { level: 3 }) }"
          @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()"
        >
          <Heading3 :size="14" class="tb-di-svg" />Heading 3
        </button>
      </ToolbarDropdown>

      <div class="tb-sep" />

      <!-- List dropdown -->
      <ToolbarDropdown :active="isListActive">
        <template #label><List :size="14" /></template>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('bulletList') }"
          @click="editor?.chain().focus().toggleBulletList().run()"
        >
          <List :size="14" class="tb-di-svg" />Bullet List
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('orderedList') }"
          @click="editor?.chain().focus().toggleOrderedList().run()"
        >
          <ListOrdered :size="14" class="tb-di-svg" />Ordered List
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('taskList') }"
          @click="editor?.chain().focus().toggleTaskList().run()"
        >
          <ListTodo :size="14" class="tb-di-svg" />Task List
        </button>
      </ToolbarDropdown>

      <div class="tb-sep" />

      <!-- Block elements -->
      <div class="tb-group">
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('blockquote') }"
          title="Blockquote"
          @click="editor?.chain().focus().toggleBlockquote().run()"
        >
          <Quote :size="14" />
        </button>
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('codeBlock') }"
          title="Code block"
          @click="editor?.chain().focus().toggleCodeBlock().run()"
        >
          <Braces :size="14" />
        </button>
      </div>

      <div class="tb-sep" />

      <!-- Inline formatting -->
      <div class="tb-group">
        <button class="tb-btn" :class="{ active: editor?.isActive('bold') }"      title="Bold (Cmd+B)"      @click="editor?.chain().focus().toggleBold().run()"><Bold :size="14" /></button>
        <button class="tb-btn" :class="{ active: editor?.isActive('italic') }"    title="Italic (Cmd+I)"    @click="editor?.chain().focus().toggleItalic().run()"><Italic :size="14" /></button>
        <button class="tb-btn" :class="{ active: editor?.isActive('strike') }"    title="Strikethrough"     @click="editor?.chain().focus().toggleStrike().run()"><Strikethrough :size="14" /></button>
        <button class="tb-btn" :class="{ active: editor?.isActive('code') }"      title="Inline code"       @click="editor?.chain().focus().toggleCode().run()"><Code :size="14" /></button>
        <button class="tb-btn" :class="{ active: editor?.isActive('underline') }" title="Underline (Cmd+U)" @click="editor?.chain().focus().toggleUnderline().run()"><UnderlineIcon :size="14" /></button>
        <button class="tb-btn" :class="{ active: editor?.isActive('highlight') }" title="Highlight"         @click="editor?.chain().focus().toggleHighlight().run()"><Highlighter :size="14" /></button>
        <div ref="linkPopupRef" class="tb-link-wrapper">
          <button class="tb-btn" :class="{ active: editor?.isActive('link') || showLinkPopup }" title="Link" @mousedown.prevent @click="setLink()">
            <Link2 :size="14" />
          </button>
          <div v-if="showLinkPopup" class="tb-link-popup">
            <input
              ref="linkInputRef"
              v-model="linkInputValue"
              class="tb-link-input"
              placeholder="Paste a link..."
              type="url"
              spellcheck="false"
              @keydown.enter.prevent="confirmLink"
              @keydown.esc="closeLinkPopup"
            />
            <div class="tb-link-sep" />
            <button class="tb-link-action" title="Apply (Enter)" @mousedown.prevent @click="confirmLink">
              <Check :size="14" />
            </button>
            <button class="tb-link-action" title="Open link" @mousedown.prevent @click="openLink">
              <ExternalLink :size="14" />
            </button>
            <button class="tb-link-action tb-link-remove" title="Remove link" @mousedown.prevent @click="removeLinkAndClose">
              <Trash2 :size="14" />
            </button>
          </div>
        </div>
      </div>

      <div class="tb-sep" />

      <!-- Superscript / Subscript -->
      <div class="tb-group">
        <button class="tb-btn" :class="{ active: editor?.isActive('superscript') }" title="Superscript" @click="editor?.chain().focus().toggleSuperscript().run()"><SuperscriptIcon :size="14" /></button>
        <button class="tb-btn" :class="{ active: editor?.isActive('subscript') }"   title="Subscript"   @click="editor?.chain().focus().toggleSubscript().run()"><SubscriptIcon :size="14" /></button>
      </div>

      <div class="tb-sep" />

      <!-- Text alignment -->
      <div class="tb-group">
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'left' }) }"    title="Align left"   @click="editor?.chain().focus().setTextAlign('left').run()"><AlignLeft :size="14" /></button>
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'center' }) }"  title="Align center" @click="editor?.chain().focus().setTextAlign('center').run()"><AlignCenter :size="14" /></button>
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'right' }) }"   title="Align right"  @click="editor?.chain().focus().setTextAlign('right').run()"><AlignRight :size="14" /></button>
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'justify' }) }" title="Justify"      @click="editor?.chain().focus().setTextAlign('justify').run()"><AlignJustify :size="14" /></button>
      </div>

      <div class="tb-sep" />

      <!-- Text color dropdown -->
      <ToolbarDropdown :active="!!editor?.getAttributes('textStyle').color">
        <template #label><Palette :size="14" /></template>
        <div class="tb-color-panel">
          <button
            v-for="color in TEXT_COLORS"
            :key="color.value"
            class="tb-color-swatch"
            :class="{ active: editor?.isActive('textStyle', { color: color.value }) }"
            :style="{ '--swatch': color.value }"
            :title="color.name"
            @click="editor?.chain().focus().setColor(color.value).run()"
          />
        </div>
        <div class="tb-color-panel-sep" />
        <div class="tb-color-panel-reset">
          <button class="tb-color-reset" title="Reset color" @click="editor?.chain().focus().unsetColor().run()">
            <RemoveFormatting :size="10" />
          </button>
        </div>
      </ToolbarDropdown>

      <div class="tb-sep" />

      <!-- Insert -->
      <div class="tb-group">
        <button class="tb-btn" title="Insert image" @click="insertImage()">
          <ImagePlus :size="14" />
        </button>
      </div>

      <div class="tb-sep" />

      <!-- Table insert -->
      <div class="tb-group">
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('table') }"
          title="Insert table (3×3)"
          @click="insertTable()"
        >
          <Table2 :size="14" />
        </button>
      </div>

    </div>

    <!-- Meeting context header (shown when this note is linked to a calendar event) -->
    <div v-if="linkedCalendarEvent" class="meeting-context-header">
      <div class="meeting-context-title">{{ linkedCalendarEvent.title }}</div>
      <div class="meeting-context-meta">
        <span class="meeting-context-time">{{ formatMeetingTime(linkedCalendarEvent) }}</span>
        <div v-if="parsedAttendees.length" class="meeting-context-attendees">
          <span
            v-for="a in parsedAttendees"
            :key="a.name || a.email"
            class="meeting-context-chip"
          >{{ a.name || a.email }}</span>
        </div>
      </div>
      <div class="meeting-context-actions">
        <span v-if="transcriptionError" class="transcription-error-msg">{{ transcriptionError }}</span>
        <button
          class="transcription-btn"
          :class="{ recording: isTranscribing }"
          :disabled="isAnotherNoteTranscribing"
          :title="isTranscribing ? 'Stop recording' : isAnotherNoteTranscribing ? 'Another note is currently being transcribed' : 'Start transcription'"
          @click="isTranscribing ? stopTranscription() : startTranscription()"
        >
          <MicOff v-if="isTranscribing" :size="12" />
          <Mic v-else :size="12" />
          {{ isTranscribing ? 'Stop' : 'Start Transcription' }}
        </button>
        <button
          class="transcript-toggle-btn"
          :class="{ active: showTranscriptPanel }"
          title="Transcript history"
          @click="showTranscriptPanel = !showTranscriptPanel"
        >
          <ScrollText :size="12" />
        </button>
      </div>
    </div>

    <!-- Editor + optional transcript side panel -->
    <div class="note-content-row">
      <div class="note-body" @mousedown="onNoteBodyMouseDown" @contextmenu="onEditorContextMenu">
        <EditorContent :editor="editor" />
      </div>

      <!-- Transcript side panel (opened via toggle button in meeting header) -->
      <div v-if="showTranscriptPanel && linkedCalendarEvent" class="transcript-side-panel">
        <div class="transcript-sp-header">
          <span class="transcript-sp-title">Transcripts</span>
          <button class="transcript-sp-close" title="Close" @click="showTranscriptPanel = false">
            <X :size="12" />
          </button>
        </div>
        <div v-if="storedTranscriptions.length === 0" class="transcript-sp-empty">
          No transcripts yet
        </div>
        <div v-for="t in storedTranscriptions" :key="t.id" class="transcript-session">
          <div class="transcript-session-header">
            <button class="transcript-session-toggle" @click="toggleTranscript(t.id)">
              <span class="transcript-session-time">{{ formatTranscriptTime(t.started_at, t.ended_at) }}</span>
              <ChevronDownIcon :size="11" :class="{ 'rotate-180': expandedTranscriptIds.includes(t.id) }" />
            </button>
            <button
              class="transcript-delete-btn"
              :class="{ confirm: pendingDeleteTranscriptId === t.id }"
              :title="pendingDeleteTranscriptId === t.id ? 'Click again to confirm' : 'Delete transcript'"
              @click.stop="deleteTranscription(t.id)"
              @blur="pendingDeleteTranscriptId = pendingDeleteTranscriptId === t.id ? null : pendingDeleteTranscriptId"
            >
              {{ pendingDeleteTranscriptId === t.id ? 'Delete?' : '×' }}
            </button>
          </div>
          <div v-if="expandedTranscriptIds.includes(t.id)" class="transcript-session-content">
            <div v-if="t.raw_transcript" class="transcript-raw-text">{{ t.raw_transcript }}</div>
          </div>
        </div>
      </div>

      <!-- Related notes side panel (toggle via ✨ button in note header) -->
      <div v-if="showRelatedPanel" class="related-notes-panel">
        <div class="related-notes-header">
          <span class="related-notes-label">Related</span>
          <button class="related-notes-close" title="Close" @click="showRelatedPanel = false">
            <X :size="12" />
          </button>
        </div>
        <div v-if="isLoadingRelated" class="related-notes-loading">
          <span class="related-notes-spinner" />
        </div>
        <template v-else>
          <div v-if="relatedNotes.length === 0" class="related-notes-empty">
            No related notes found
          </div>
          <button
            v-for="note in relatedNotes"
            :key="note.id"
            class="related-note-item"
            @click="onOpenRelatedNote($event, note.id, note.title)"
          >
            <span class="related-note-title">{{ note.title }}</span>
            <span v-if="note.excerpt" class="related-note-excerpt">{{ note.excerpt }}</span>
          </button>
        </template>
      </div>
    </div>

    <!-- Live transcription status bar (only while recording is active) -->
    <div v-if="isTranscribing" class="transcript-live-bar">
      <span class="transcript-recording-dot" />
      <span class="transcript-live-label">Recording</span>
      <span v-if="lastTranscriptLine" class="transcript-live-text">{{ lastTranscriptLine }}</span>
      <span v-else class="transcript-live-waiting">Listening…</span>
    </div>

    <!-- Backlinks: notes that [[link]] to this note -->
    <div v-if="backlinks.length > 0" class="backlinks-bar">
      <button class="backlinks-toggle" @click="showBacklinks = !showBacklinks">
        <Link2 :size="11" />
        <span>{{ backlinks.length }} {{ backlinks.length === 1 ? 'note links here' : 'notes link here' }}</span>
        <ChevronDownIcon :size="11" :class="{ 'rotate-180': showBacklinks }" />
      </button>
      <div v-if="showBacklinks" class="backlinks-list">
        <button
          v-for="bl in backlinks"
          :key="bl.id"
          class="backlinks-item"
          @click="onOpenBacklink($event, bl.id, bl.title)"
        >
          {{ bl.title }}
        </button>
      </div>
    </div>

    <TrashedMentionPopup
      v-if="popupEntityId && popupAnchorRect && entityTrashStatus.get(popupEntityId)"
      :key="`trashed-${popupEntityId}`"
      :entity-id="popupEntityId"
      :anchor-rect="popupAnchorRect"
      @close="popupEntityId = null"
      @restored="popupEntityId = null"
    />

    <EntityMentionPopup
      v-if="popupEntityId && popupAnchorRect && !entityTrashStatus.get(popupEntityId)"
      :key="`entity-${popupEntityId}`"
      :entity-id="popupEntityId"
      :anchor-rect="popupAnchorRect"
      @close="popupEntityId = null"
      @open-entity="emit('open-entity', $event)"
    />

    <TrashedNoteLinkPopup
      v-if="popupNoteId && popupNoteAnchorRect && noteArchivedStatus.get(popupNoteId)"
      :key="`archived-note-${popupNoteId}`"
      :note-id="popupNoteId"
      :anchor-rect="popupNoteAnchorRect"
      @close="popupNoteId = null"
      @restored="popupNoteId = null"
    />
    <NoteLinkPopup
      v-else-if="popupNoteId && popupNoteAnchorRect && !noteArchivedStatus.get(popupNoteId)"
      :key="`note-link-${popupNoteId}`"
      :note-id="popupNoteId"
      :anchor-rect="popupNoteAnchorRect"
      @close="popupNoteId = null"
      @open-note="emit('open-note', $event)"
    />

    <AutoMentionPopup
      v-if="hoveredAutoDetection"
      :detection="hoveredAutoDetection"
      @insert="onInsertAutoMention"
    />

    <!-- Date picker popup (shown when /date slash command is used) -->
    <div v-if="showDatePicker" class="date-picker-overlay">
      <div ref="datePickerPopupRef" class="date-picker-popup">
        <span class="date-picker-label">Insert date</span>
        <input
          ref="datePickerInputRef"
          v-model="datePickerValue"
          type="date"
          class="date-picker-input"
          @keydown.enter.prevent="confirmDate"
          @keydown.esc="closeDatePicker"
        />
        <div class="date-picker-actions">
          <button class="date-picker-cancel" @mousedown.prevent @click="closeDatePicker">Cancel</button>
          <button class="date-picker-confirm" @mousedown.prevent @click="confirmDate">Insert</button>
        </div>
      </div>
    </div>

    <!-- Extracting actions indicator (shown while /action slash command calls Claude) -->
    <div v-if="isExtractingActions" class="actions-extracting">
      <span class="actions-extracting-spinner" />
      Extracting action items…
    </div>

    <!-- Table context menu (right-click inside table) -->
    <TableContextMenu
      v-if="tableContextMenu && editor"
      :editor="editor"
      :x="tableContextMenu.x"
      :y="tableContextMenu.y"
      @close="closeTableContextMenu"
    />
  </div>
</template>

<style scoped>
.date-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.3);
}

.date-picker-popup {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 220px;
}

.date-picker-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.date-picker-input {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text);
  font-size: 13px;
  padding: 6px 8px;
  width: 100%;
  outline: none;
  box-sizing: border-box;
}

.date-picker-input:focus {
  border-color: var(--color-accent);
}

.date-picker-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.date-picker-cancel,
.date-picker-confirm {
  border: none;
  border-radius: 5px;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
  font-weight: 500;
}

.date-picker-cancel {
  background: transparent;
  color: var(--color-text-muted);
}

.date-picker-cancel:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
}

.date-picker-confirm {
  background: var(--color-accent, #5b8def);
  color: #fff;
}

.date-picker-confirm:hover {
  opacity: 0.88;
}

.actions-extracting {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 12px;
  color: var(--color-text-muted);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  z-index: 9000;
  pointer-events: none;
}

.actions-extracting-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.related-notes-toggle-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}

.related-notes-toggle-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.related-notes-toggle-btn.active {
  background: rgba(91, 141, 239, 0.12);
  border-color: rgba(91, 141, 239, 0.4);
  color: var(--color-accent);
}

.backlinks-bar {
  border-top: 1px solid var(--color-border);
  padding: 0 20px;
}

.backlinks-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  background: none;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
  padding: 6px 0;
  width: 100%;
  text-align: left;
}

.backlinks-toggle:hover {
  color: var(--color-text);
}

.backlinks-toggle .rotate-180 {
  transform: rotate(180deg);
}

.backlinks-list {
  display: flex;
  flex-direction: column;
  padding-bottom: 6px;
}

.backlinks-item {
  background: none;
  border: none;
  color: var(--color-text-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  padding: 3px 0 3px 16px;
  border-radius: 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backlinks-item:hover {
  color: var(--color-text);
  background: var(--color-surface-hover);
}

/* ── Table styles ──────────────────────────────────────────── */
.note-body :deep(.tiptap table) {
  border-collapse: collapse;
  margin: 12px 0;
  width: 100%;
  table-layout: fixed;
  overflow: auto;
}

.note-body :deep(.tiptap table td),
.note-body :deep(.tiptap table th) {
  border: 1px solid var(--color-border);
  padding: 6px 10px;
  position: relative;
  vertical-align: top;
  min-width: 80px;
  box-sizing: border-box;
}

.note-body :deep(.tiptap table td p),
.note-body :deep(.tiptap table th p) {
  margin: 0;
}

.note-body :deep(.tiptap table th) {
  background: rgba(255, 255, 255, 0.04);
  font-weight: 600;
  text-align: left;
}

.note-body :deep(.tiptap table .selectedCell::after) {
  background: rgba(91, 141, 239, 0.15);
  content: '';
  inset: 0;
  pointer-events: none;
  position: absolute;
  z-index: 2;
}

.note-body :deep(.tiptap table .column-resize-handle) {
  background-color: #5b8def;
  bottom: -2px;
  pointer-events: none;
  position: absolute;
  right: -2px;
  top: 0;
  width: 3px;
}

.note-body :deep(.tiptap.resize-cursor) {
  cursor: col-resize;
}
</style>
