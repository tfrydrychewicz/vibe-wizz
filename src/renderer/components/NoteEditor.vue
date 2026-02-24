<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount, nextTick } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
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
import ToolbarDropdown from './ToolbarDropdown.vue'
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
} from 'lucide-vue-next'

const props = defineProps<{ noteId: string }>()

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

const showLinkPopup = ref(false)
const linkInputValue = ref('')
const linkInputRef = ref<HTMLInputElement | null>(null)
const linkPopupRef = ref<HTMLElement | null>(null)

let savedFrom = 0
let savedTo = 0
let saveTimer: ReturnType<typeof setTimeout> | null = null
let isLoading = false

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
    TaskItem.configure({ nested: true }),
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
  } catch {
    saveStatus.value = 'unsaved'
  }
}

async function loadNote(noteId: string): Promise<void> {
  isLoading = true
  saveStatus.value = 'saved'
  try {
    const note = (await window.api.invoke('notes:get', { id: noteId })) as NoteRow | null
    if (!note || !editor.value) return
    title.value = note.title
    let content: object = { type: 'doc', content: [] }
    try {
      if (note.body && note.body !== '{}') {
        content = JSON.parse(note.body) as object
      }
    } catch {
      // malformed body — use empty doc
    }
    editor.value.commands.setContent(content)
  } finally {
    await nextTick()
    isLoading = false
  }
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

      <!-- Text color -->
      <div class="tb-group tb-colors">
        <button
          v-for="color in TEXT_COLORS"
          :key="color.value"
          class="tb-color-swatch"
          :class="{ active: editor?.isActive('textStyle', { color: color.value }) }"
          :style="{ '--swatch': color.value }"
          :title="color.name"
          @click="editor?.chain().focus().setColor(color.value).run()"
        />
        <button class="tb-color-reset" title="Reset color" @click="editor?.chain().focus().unsetColor().run()">
          <RemoveFormatting :size="10" />
        </button>
      </div>

      <div class="tb-sep" />

      <!-- Insert -->
      <div class="tb-group">
        <button class="tb-btn" title="Insert image" @click="insertImage()">
          <ImagePlus :size="14" />
        </button>
      </div>

    </div>

    <EditorContent :editor="editor" class="note-body" />
  </div>
</template>
