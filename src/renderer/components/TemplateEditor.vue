<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'
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
import { TaskList } from '@tiptap/extension-task-list'
import { TaskItem } from '@tiptap/extension-task-item'
import { Image as TiptapImage } from '@tiptap/extension-image'
import { Table } from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableCell from '@tiptap/extension-table-cell'
import TableHeader from '@tiptap/extension-table-header'
import IconPicker from './IconPicker.vue'
import LucideIcon from './LucideIcon.vue'
import ToolbarDropdown from './ToolbarDropdown.vue'
import {
  Undo2, Redo2,
  Pilcrow, Heading1, Heading2, Heading3,
  List, ListOrdered, ListTodo,
  Quote, Braces,
  Bold, Italic, Strikethrough, Code,
  Underline as UnderlineIcon,
  Highlighter,
  Superscript as SuperscriptIcon,
  Subscript as SubscriptIcon,
  AlignLeft, AlignCenter, AlignRight, AlignJustify,
  RemoveFormatting,
  Table2,
} from 'lucide-vue-next'
import { computed } from 'vue'

const props = defineProps<{ templateId: string }>()
const emit = defineEmits<{
  saved: [name: string]
  loaded: [name: string]
}>()

type NoteTemplateRow = {
  id: string
  name: string
  icon: string
  body: string
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

const name = ref('Untitled')
const icon = ref('file-text')
const showIconPicker = ref(false)
const saveStatus = ref<'saved' | 'saving' | 'unsaved'>('saved')

let saveTimer: ReturnType<typeof setTimeout> | null = null
let isLoading = false

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

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      dropcursor: { color: '#5b8def', width: 2 },
    }),
    Placeholder.configure({ placeholder: 'Define your template content…' }),
    TextStyle,
    Color,
    Underline,
    Highlight.configure({ multicolor: false }),
    Superscript,
    Subscript,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    TiptapImage.configure({ allowBase64: true, HTMLAttributes: { class: 'editor-image' } }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
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

function insertTable(): void {
  editor.value?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
}

async function flushSave(overrideId?: string): Promise<void> {
  saveTimer = null
  if (!editor.value) return
  const id = overrideId ?? props.templateId
  saveStatus.value = 'saving'
  try {
    await window.api.invoke('templates:update', {
      id,
      name: name.value || 'Untitled',
      icon: icon.value || 'file-text',
      body: JSON.stringify(editor.value.getJSON()),
    })
    saveStatus.value = 'saved'
    emit('saved', name.value || 'Untitled')
  } catch {
    saveStatus.value = 'unsaved'
  }
}

async function loadTemplate(templateId: string): Promise<void> {
  isLoading = true
  saveStatus.value = 'saved'
  try {
    const tmpl = (await window.api.invoke('templates:get', { id: templateId })) as NoteTemplateRow | null
    if (!tmpl || !editor.value) return
    name.value = tmpl.name
    icon.value = tmpl.icon || 'file-text'
    let content: object = { type: 'doc', content: [] }
    try {
      if (tmpl.body && tmpl.body !== '{}') {
        content = JSON.parse(tmpl.body) as object
      }
    } catch {
      // malformed body — use empty doc
    }
    editor.value.commands.setContent(content)
  } finally {
    await nextTick()
    isLoading = false
  }
  emit('loaded', name.value || 'Untitled')
}

watch(
  () => props.templateId,
  async (newId, oldId) => {
    if (saveTimer && oldId) {
      clearTimeout(saveTimer)
      saveTimer = null
      if (editor.value) {
        await window.api.invoke('templates:update', {
          id: oldId,
          name: name.value || 'Untitled',
          icon: icon.value || 'file-text',
          body: JSON.stringify(editor.value.getJSON()),
        })
      }
    }
    await loadTemplate(newId)
  },
  { immediate: true }
)

watch(name, scheduleSave)
watch(icon, scheduleSave)

onBeforeUnmount(() => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    flushSave()
  }
  editor.value?.destroy()
})
</script>

<template>
  <div class="template-editor">
    <div class="template-header">
      <button
        class="template-icon-btn"
        title="Change icon"
        @click="showIconPicker = !showIconPicker"
      >
        <LucideIcon :name="icon || 'file-text'" :size="18" />
      </button>
      <div v-if="showIconPicker" class="icon-picker-overlay" @click.self="showIconPicker = false">
        <div class="icon-picker-popup">
          <IconPicker v-model="icon" @update:model-value="showIconPicker = false" />
        </div>
      </div>
      <input
        v-model="name"
        class="template-name-input"
        type="text"
        placeholder="Template name"
        spellcheck="false"
      />
      <span class="save-status" :data-status="saveStatus">
        {{ saveStatus === 'saving' ? 'Saving…' : saveStatus === 'unsaved' ? 'Unsaved' : '' }}
      </span>
    </div>

    <p class="template-hint">
      Write the default content for this template. When a note is created from it, this body is copied in.
    </p>

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

    <div class="template-body">
      <EditorContent :editor="editor" />
    </div>
  </div>
</template>

<style scoped>
.template-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.template-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px 8px;
  flex-shrink: 0;
  position: relative;
}

.template-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
  flex-shrink: 0;
}

.template-icon-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
}

.icon-picker-overlay {
  position: fixed;
  inset: 0;
  z-index: 9000;
}

.icon-picker-popup {
  position: absolute;
  top: 44px;
  left: 20px;
  z-index: 9001;
  background: #1e1e1e;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  overflow: hidden;
}

.template-name-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text);
  font-family: inherit;
  min-width: 0;
}

.template-name-input::placeholder {
  color: var(--color-text-muted);
  opacity: 0.5;
}

.save-status {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
  min-width: 60px;
  text-align: right;
}

.save-status[data-status='unsaved'] { color: #f0a050; }
.save-status[data-status='saving']  { color: #888; }

.template-hint {
  margin: 0 20px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.6;
  line-height: 1.4;
}

.template-body {
  flex: 1;
  overflow-y: auto;
  padding: 0 20px 20px;
}

/* Reuse NoteEditor toolbar styles — same class names */
.format-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  padding: 4px 10px;
  border-top: 1px solid var(--color-border);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  flex-shrink: 0;
}

.tb-group {
  display: flex;
  align-items: center;
  gap: 1px;
}

.tb-sep {
  width: 1px;
  height: 16px;
  background: var(--color-border);
  margin: 0 3px;
  flex-shrink: 0;
}

.tb-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
  flex-shrink: 0;
}

.tb-btn:hover { background: rgba(255,255,255,0.07); color: var(--color-text); }
.tb-btn.active { background: rgba(91,141,239,0.15); color: #5b8def; }

.tb-align { width: 26px; }

.tb-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
}

.tb-dropdown-item:hover { background: rgba(255,255,255,0.06); color: var(--color-text); }
.tb-dropdown-item.active { color: #5b8def; }
.tb-di-svg { flex-shrink: 0; }

.tb-colors {
  gap: 3px;
  align-items: center;
}

.tb-color-swatch {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--swatch);
  border: 2px solid transparent;
  cursor: pointer;
  transition: border-color 0.1s, transform 0.1s;
  flex-shrink: 0;
}

.tb-color-swatch:hover,
.tb-color-swatch.active {
  border-color: var(--swatch);
  transform: scale(1.25);
  outline: 1.5px solid rgba(255,255,255,0.3);
  outline-offset: 1px;
}

.tb-color-reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--color-text-muted);
  cursor: pointer;
}

.tb-color-reset:hover { background: rgba(255,255,255,0.07); color: var(--color-text); }

/* TipTap editor content inside template-body */
.template-body :deep(.tiptap) {
  outline: none;
  min-height: 200px;
  font-size: 15px;
  line-height: 1.7;
  color: var(--color-text);
  padding-top: 8px;
}

.template-body :deep(.tiptap p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: var(--color-text-muted);
  pointer-events: none;
  float: left;
  height: 0;
}

.template-body :deep(.tiptap h1) { font-size: 22px; font-weight: 700; margin: 24px 0 8px; }
.template-body :deep(.tiptap h2) { font-size: 19px; font-weight: 600; margin: 20px 0 6px; }
.template-body :deep(.tiptap h3) { font-size: 16px; font-weight: 600; margin: 16px 0 4px; }
.template-body :deep(.tiptap p)  { margin: 0 0 8px; }

.template-body :deep(.tiptap ul),
.template-body :deep(.tiptap ol) { padding-left: 24px; margin: 0 0 8px; }
.template-body :deep(.tiptap li) { margin: 2px 0; }

.template-body :deep(.tiptap code) {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 13px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: #e06c75;
}

.template-body :deep(.tiptap pre) {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 14px 16px;
  margin: 8px 0;
  overflow-x: auto;
}

.template-body :deep(.tiptap pre code) { background: none; border: none; padding: 0; color: var(--color-text); font-size: 13px; }

.template-body :deep(.tiptap blockquote) {
  border-left: 3px solid var(--color-accent);
  margin: 8px 0;
  padding-left: 16px;
  color: var(--color-text-muted);
}

.template-body :deep(.tiptap strong) { color: var(--color-text); font-weight: 600; }
.template-body :deep(.tiptap em)     { color: var(--color-text); }
.template-body :deep(.tiptap mark)   { background: #eab30840; color: var(--color-text); border-radius: 2px; padding: 0 2px; }

.template-body :deep(.tiptap ul[data-type="taskList"]) { list-style: none; padding-left: 4px; margin: 0 0 8px; }
.template-body :deep(.tiptap ul[data-type="taskList"] li) { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; }
.template-body :deep(.tiptap ul[data-type="taskList"] li > label) { flex-shrink: 0; padding-top: 4px; cursor: pointer; }
.template-body :deep(.tiptap ul[data-type="taskList"] li > label input[type="checkbox"]) { width: 14px; height: 14px; cursor: pointer; accent-color: var(--color-accent); }
.template-body :deep(.tiptap ul[data-type="taskList"] li[data-checked="true"] > div) { text-decoration: line-through; color: var(--color-text-muted); }

/* ── Table styles ──────────────────────────────────────────── */
.template-body :deep(.tiptap table) {
  border-collapse: collapse;
  margin: 12px 0;
  width: 100%;
  table-layout: fixed;
  overflow: auto;
}

.template-body :deep(.tiptap table td),
.template-body :deep(.tiptap table th) {
  border: 1px solid var(--color-border);
  padding: 6px 10px;
  position: relative;
  vertical-align: top;
  min-width: 80px;
  box-sizing: border-box;
}

.template-body :deep(.tiptap table td p),
.template-body :deep(.tiptap table th p) {
  margin: 0;
}

.template-body :deep(.tiptap table th) {
  background: rgba(255, 255, 255, 0.04);
  font-weight: 600;
  text-align: left;
}

/* ── Inline images ───────────────────────────────────────────────────────── */
.template-body :deep(.editor-image) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  display: block;
  margin: 8px 0;
  cursor: default;
}

.template-body :deep(.tiptap table .selectedCell::after) {
  background: rgba(91, 141, 239, 0.15);
  content: '';
  inset: 0;
  pointer-events: none;
  position: absolute;
  z-index: 2;
}
</style>
