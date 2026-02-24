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

// Computed labels for dropdowns — reactive because editor ref updates on state change
const headingLabel = computed(() => {
  if (!editor.value) return 'P'
  for (const level of [1, 2, 3] as const) {
    if (editor.value.isActive('heading', { level })) return `H${level}`
  }
  return 'P'
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
  const prev = editor.value?.getAttributes('link').href as string | undefined
  const url = window.prompt('Enter URL', prev ?? 'https://')
  if (url === null) return
  if (url === '') {
    editor.value?.chain().focus().extendMarkRange('link').unsetLink().run()
  } else {
    editor.value?.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
  }
}

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
        <button class="tb-btn" title="Undo (Cmd+Z)"
          @click="editor?.chain().focus().undo().run()">↩</button>
        <button class="tb-btn" title="Redo (Cmd+Shift+Z)"
          @click="editor?.chain().focus().redo().run()">↪</button>
      </div>

      <div class="tb-sep" />

      <!-- Heading dropdown -->
      <ToolbarDropdown :active="isHeadingActive">
        <template #label>{{ headingLabel }}</template>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('paragraph') && !editor?.isActive('heading') }"
          @click="editor?.chain().focus().setParagraph().run()"
        >
          <span class="tb-di-icon tb-di-p">P</span>Paragraph
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('heading', { level: 1 }) }"
          @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
        >
          <span class="tb-di-icon tb-di-h1">H1</span>Heading 1
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('heading', { level: 2 }) }"
          @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"
        >
          <span class="tb-di-icon tb-di-h2">H2</span>Heading 2
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('heading', { level: 3 }) }"
          @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()"
        >
          <span class="tb-di-icon tb-di-h3">H3</span>Heading 3
        </button>
      </ToolbarDropdown>

      <div class="tb-sep" />

      <!-- List dropdown -->
      <ToolbarDropdown :active="isListActive">
        <template #label>
          <svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor">
            <rect x="5" y="0" width="9" height="2" rx="1"/>
            <rect x="5" y="5" width="9" height="2" rx="1"/>
            <rect x="5" y="10" width="9" height="2" rx="1"/>
            <circle cx="1.5" cy="1" r="1.5"/>
            <circle cx="1.5" cy="6" r="1.5"/>
            <circle cx="1.5" cy="11" r="1.5"/>
          </svg>
        </template>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('bulletList') }"
          @click="editor?.chain().focus().toggleBulletList().run()"
        >
          <svg class="tb-di-svg" viewBox="0 0 16 14" fill="currentColor">
            <rect x="6" y="1" width="10" height="2" rx="1"/>
            <rect x="6" y="6" width="10" height="2" rx="1"/>
            <rect x="6" y="11" width="10" height="2" rx="1"/>
            <circle cx="2" cy="2" r="1.8"/>
            <circle cx="2" cy="7" r="1.8"/>
            <circle cx="2" cy="12" r="1.8"/>
          </svg>
          Bullet List
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('orderedList') }"
          @click="editor?.chain().focus().toggleOrderedList().run()"
        >
          <svg class="tb-di-svg" viewBox="0 0 16 14" fill="currentColor">
            <rect x="6" y="1" width="10" height="2" rx="1"/>
            <rect x="6" y="6" width="10" height="2" rx="1"/>
            <rect x="6" y="11" width="10" height="2" rx="1"/>
            <text x="1" y="4" font-size="4.5" font-weight="bold">1</text>
            <text x="1" y="9" font-size="4.5" font-weight="bold">2</text>
            <text x="1" y="14" font-size="4.5" font-weight="bold">3</text>
          </svg>
          Ordered List
        </button>
        <button
          class="tb-dropdown-item"
          :class="{ active: editor?.isActive('taskList') }"
          @click="editor?.chain().focus().toggleTaskList().run()"
        >
          <svg class="tb-di-svg" viewBox="0 0 16 14" fill="none" stroke="currentColor" stroke-width="1.2">
            <rect x="1" y="0" width="4" height="4" rx="0.8"/>
            <polyline points="2,2 3,3 4.5,1" stroke-linecap="round" stroke-linejoin="round"/>
            <rect x="1" y="5" width="4" height="4" rx="0.8"/>
            <rect x="1" y="10" width="4" height="4" rx="0.8"/>
            <line x1="6.5" y1="2" x2="15" y2="2"/>
            <line x1="6.5" y1="7" x2="15" y2="7"/>
            <line x1="6.5" y1="12" x2="15" y2="12"/>
          </svg>
          Task List
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
        >❝</button>
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('codeBlock') }"
          title="Code block"
          @click="editor?.chain().focus().toggleCodeBlock().run()"
        >{ }</button>
      </div>

      <div class="tb-sep" />

      <!-- Inline formatting -->
      <div class="tb-group">
        <button class="tb-btn tb-bold"      :class="{ active: editor?.isActive('bold') }"      title="Bold (Cmd+B)"      @click="editor?.chain().focus().toggleBold().run()">B</button>
        <button class="tb-btn tb-italic"    :class="{ active: editor?.isActive('italic') }"    title="Italic (Cmd+I)"    @click="editor?.chain().focus().toggleItalic().run()">I</button>
        <button class="tb-btn tb-strike"    :class="{ active: editor?.isActive('strike') }"    title="Strikethrough"     @click="editor?.chain().focus().toggleStrike().run()">S</button>
        <button class="tb-btn tb-code"      :class="{ active: editor?.isActive('code') }"      title="Inline code"       @click="editor?.chain().focus().toggleCode().run()">&lt;/&gt;</button>
        <button class="tb-btn tb-underline" :class="{ active: editor?.isActive('underline') }" title="Underline (Cmd+U)" @click="editor?.chain().focus().toggleUnderline().run()">U</button>
        <button class="tb-btn tb-highlight" :class="{ active: editor?.isActive('highlight') }" title="Highlight"         @click="editor?.chain().focus().toggleHighlight().run()">▐</button>
        <button class="tb-btn"              :class="{ active: editor?.isActive('link') }"       title="Link"              @click="setLink()">⛓</button>
      </div>

      <div class="tb-sep" />

      <!-- Superscript / Subscript -->
      <div class="tb-group">
        <button class="tb-btn" :class="{ active: editor?.isActive('superscript') }" title="Superscript" @click="editor?.chain().focus().toggleSuperscript().run()">x²</button>
        <button class="tb-btn" :class="{ active: editor?.isActive('subscript') }"   title="Subscript"   @click="editor?.chain().focus().toggleSubscript().run()">x₂</button>
      </div>

      <div class="tb-sep" />

      <!-- Text alignment — inline SVG icons -->
      <div class="tb-group">
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'left' }) }"    title="Align left"   @click="editor?.chain().focus().setTextAlign('left').run()">
          <svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="0" y="5" width="14" height="2" rx="1"/><rect x="0" y="10" width="8"  height="2" rx="1"/></svg>
        </button>
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'center' }) }"  title="Align center" @click="editor?.chain().focus().setTextAlign('center').run()">
          <svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="0" y="5" width="14" height="2" rx="1"/><rect x="3" y="10" width="8"  height="2" rx="1"/></svg>
        </button>
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'right' }) }"   title="Align right"  @click="editor?.chain().focus().setTextAlign('right').run()">
          <svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="0" y="5" width="14" height="2" rx="1"/><rect x="6" y="10" width="8"  height="2" rx="1"/></svg>
        </button>
        <button class="tb-btn tb-align" :class="{ active: editor?.isActive({ textAlign: 'justify' }) }" title="Justify"      @click="editor?.chain().focus().setTextAlign('justify').run()">
          <svg viewBox="0 0 14 12" width="14" height="12" fill="currentColor"><rect x="0" y="0" width="14" height="2" rx="1"/><rect x="0" y="5" width="14" height="2" rx="1"/><rect x="0" y="10" width="14" height="2" rx="1"/></svg>
        </button>
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
        <button class="tb-color-reset" title="Reset color"
          @click="editor?.chain().focus().unsetColor().run()">✕</button>
      </div>

      <div class="tb-sep" />

      <!-- Insert -->
      <div class="tb-group">
        <button class="tb-btn" title="Insert image" @click="insertImage()">⊞ Add</button>
      </div>

    </div>

    <EditorContent :editor="editor" class="note-body" />
  </div>
</template>
