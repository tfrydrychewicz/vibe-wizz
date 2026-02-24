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
} from 'lucide-vue-next'

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

// Loading state while /action slash command calls Claude to extract actions
const isExtractingActions = ref(false)

const showLinkPopup = ref(false)
const linkInputValue = ref('')
const linkInputRef = ref<HTMLInputElement | null>(null)
const linkPopupRef = ref<HTMLElement | null>(null)

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
]

async function extractAndInsertActions(
  ed: { chain(): { focus(): { insertContent(c: unknown): { run(): void } } } },
  bodyPlain: string
): Promise<void> {
  isExtractingActions.value = true
  try {
    const result = (await window.api.invoke('notes:extract-actions', { body_plain: bodyPlain })) as {
      items: string[]
    }
    if (!result.items.length) return
    ed.chain().focus().insertContent([
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Action Items' }] },
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
    const note = (await window.api.invoke('notes:get', { id: noteId })) as NoteRow | null
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
    await loadNote(newId)
  },
  { immediate: true }
)

watch(title, scheduleSave)

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onLinkPopupOutside)
  unsubscribeNer()
  unsubscribeActionStatus()
  unsubscribeActionUnlinked()
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

    </div>

    <div class="note-body">
      <EditorContent :editor="editor" />
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

    <!-- Extracting actions indicator (shown while /action slash command calls Claude) -->
    <div v-if="isExtractingActions" class="actions-extracting">
      <span class="actions-extracting-spinner" />
      Extracting action items…
    </div>
  </div>
</template>

<style scoped>
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
</style>
