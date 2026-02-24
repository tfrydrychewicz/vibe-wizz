<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'

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
  ],
  content: { type: 'doc', content: [] },
  onUpdate() {
    scheduleSave()
  },
})

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

watch(
  () => props.noteId,
  async (newId, oldId) => {
    // Flush any pending changes for the outgoing note
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
      <!-- Paragraph style -->
      <div class="tb-group">
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('paragraph') && !editor?.isActive('heading') }"
          title="Paragraph"
          @click="editor?.chain().focus().setParagraph().run()"
        >P</button>
        <button
          class="tb-btn tb-heading"
          :class="{ active: editor?.isActive('heading', { level: 1 }) }"
          title="Heading 1"
          @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()"
        >H1</button>
        <button
          class="tb-btn tb-heading"
          :class="{ active: editor?.isActive('heading', { level: 2 }) }"
          title="Heading 2"
          @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()"
        >H2</button>
        <button
          class="tb-btn tb-heading"
          :class="{ active: editor?.isActive('heading', { level: 3 }) }"
          title="Heading 3"
          @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()"
        >H3</button>
      </div>

      <div class="tb-sep" />

      <!-- Inline formatting -->
      <div class="tb-group">
        <button
          class="tb-btn tb-bold"
          :class="{ active: editor?.isActive('bold') }"
          title="Bold (Cmd+B)"
          @click="editor?.chain().focus().toggleBold().run()"
        >B</button>
        <button
          class="tb-btn tb-italic"
          :class="{ active: editor?.isActive('italic') }"
          title="Italic (Cmd+I)"
          @click="editor?.chain().focus().toggleItalic().run()"
        >I</button>
        <button
          class="tb-btn tb-strike"
          :class="{ active: editor?.isActive('strike') }"
          title="Strikethrough"
          @click="editor?.chain().focus().toggleStrike().run()"
        >S</button>
        <button
          class="tb-btn tb-code"
          :class="{ active: editor?.isActive('code') }"
          title="Inline Code"
          @click="editor?.chain().focus().toggleCode().run()"
        >&lt;/&gt;</button>
      </div>

      <div class="tb-sep" />

      <!-- Block elements -->
      <div class="tb-group">
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('bulletList') }"
          title="Bullet List"
          @click="editor?.chain().focus().toggleBulletList().run()"
        >≡•</button>
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('orderedList') }"
          title="Ordered List"
          @click="editor?.chain().focus().toggleOrderedList().run()"
        >1.</button>
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('blockquote') }"
          title="Blockquote"
          @click="editor?.chain().focus().toggleBlockquote().run()"
        >❝</button>
        <button
          class="tb-btn"
          :class="{ active: editor?.isActive('codeBlock') }"
          title="Code Block"
          @click="editor?.chain().focus().toggleCodeBlock().run()"
        >{ }</button>
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
        <button
          class="tb-color-reset"
          title="Reset color"
          @click="editor?.chain().focus().unsetColor().run()"
        >✕</button>
      </div>
    </div>

    <EditorContent :editor="editor" class="note-body" />
  </div>
</template>
