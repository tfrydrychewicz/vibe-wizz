<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { FileText, ExternalLink } from 'lucide-vue-next'
import type { OpenMode } from '../stores/tabStore'
import { noteBodyToHtml } from '../utils/noteToHtml'
import { useEntityChips } from '../composables/useEntityChips'

const props = withDefaults(
  defineProps<{
    noteId: string
    noteTitle: string
    /** Fixed height in px. Default 140. */
    height?: number
  }>(),
  { height: 140 },
)

const emit = defineEmits<{
  'open-note': [payload: { noteId: string; title: string; mode: OpenMode }]
  'open-entity': [payload: { entityId: string; typeId?: string; mode: OpenMode }]
}>()

const bodyHtml = ref('')
const loading = ref(true)
const previewContentRef = ref<HTMLElement | null>(null)
const { applyAfterTick } = useEntityChips()

async function loadNote(): Promise<void> {
  if (!props.noteId) {
    bodyHtml.value = ''
    loading.value = false
    return
  }
  loading.value = true
  try {
    const note = (await window.api.invoke('notes:get', { id: props.noteId })) as { body?: string } | null
    bodyHtml.value = noteBodyToHtml(note?.body)
    await applyAfterTick(previewContentRef.value)
  } finally {
    loading.value = false
  }
}

watch(() => props.noteId, loadNote, { immediate: true })
onMounted(() => loadNote())

watch(bodyHtml, async () => {
  await applyAfterTick(previewContentRef.value)
})

function openNote(e: MouseEvent): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: props.noteId, title: props.noteTitle, mode })
}

function onPreviewClick(e: MouseEvent): void {
  const target = e.target as HTMLElement
  const entityBtn = target.closest('[data-entity-name]') as HTMLElement | null
  if (entityBtn) {
    const entityId = entityBtn.dataset.entityId
    if (entityId) {
      const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
      emit('open-entity', { entityId, mode })
      return
    }
  }
  const noteBtn = target.closest('[data-note-title]') as HTMLElement | null
  if (noteBtn) {
    const noteId = noteBtn.dataset.noteId
    if (noteId) {
      const title = noteBtn.dataset.noteTitle ?? 'Untitled'
      const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
      emit('open-note', { noteId, title, mode })
      return
    }
  }
}
</script>

<template>
  <div class="task-note-preview">
    <div class="preview-header">
      <button class="preview-title-btn" @click="openNote($event)">
        <FileText :size="11" />
        {{ noteTitle || 'Untitled' }}
      </button>
      <button class="preview-open-btn" title="Open note" aria-label="Open note" @click="openNote($event)">
        <ExternalLink :size="11" />
      </button>
    </div>
    <div class="preview-content" :style="{ height: height + 'px' }" @click="onPreviewClick">
      <div v-if="loading" class="preview-loading">Loading…</div>
      <div
        v-else-if="bodyHtml"
        ref="previewContentRef"
        class="note-body task-note-preview-body"
      >
        <div class="tiptap" v-html="bodyHtml" />
      </div>
      <div v-else class="preview-empty">No content</div>
    </div>
  </div>
</template>

<style scoped>
.task-note-preview {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
}

.preview-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px 4px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.preview-title-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 0;
}

.preview-title-btn:hover {
  color: var(--color-accent);
}

.preview-open-btn {
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  flex-shrink: 0;
}

.preview-open-btn:hover {
  color: var(--color-accent);
  background: var(--color-hover);
}

.preview-content {
  overflow-y: auto;
  padding: 8px 10px;
  min-height: 0;
}

.preview-loading,
.preview-empty {
  font-size: 12px;
  color: var(--color-text-muted);
  opacity: 0.6;
}

/* Reuse note-body .tiptap styles so rich content matches the note view.
   Override global .note-body .tiptap font-sizes (15px base, 22/19/16 for h1–h3) at 85%. */
.task-note-preview-body {
  padding: 0;
}

.task-note-preview-body .tiptap {
  min-height: 0;
  padding: 0;
  font-size: 12.75px; /* 85% of 15px */
}

.task-note-preview-body .tiptap h1 { font-size: 18.7px; }
.task-note-preview-body .tiptap h2 { font-size: 16.15px; }
.task-note-preview-body .tiptap h3 { font-size: 13.6px; }
.task-note-preview-body .tiptap code,
.task-note-preview-body .tiptap pre code { font-size: 11.05px; }
.task-note-preview-body .tiptap p:last-child {
  margin-bottom: 0;
}

/* Chips inside preview need pointer cursor */
.task-note-preview-body .wizz-entity-chip,
.task-note-preview-body .wizz-note-chip {
  cursor: pointer;
}
</style>
