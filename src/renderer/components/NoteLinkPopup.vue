<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { FileText } from 'lucide-vue-next'
import type { OpenMode } from '../stores/tabStore'

type NoteRow = {
  id: string
  title: string
  body: string
  body_plain: string
}

const props = defineProps<{
  noteId: string
  anchorRect: DOMRect
}>()

const emit = defineEmits<{
  close: []
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

const note = ref<NoteRow | null>(null)
const failed = ref(false)
const popupRef = ref<HTMLElement | null>(null)

const POPUP_APPROX_HEIGHT = 100

const popupTop = computed(() => {
  const spaceBelow = window.innerHeight - props.anchorRect.bottom
  if (spaceBelow < POPUP_APPROX_HEIGHT + 16) {
    return Math.max(8, props.anchorRect.top - POPUP_APPROX_HEIGHT - 8)
  }
  return props.anchorRect.bottom + 8
})

const popupLeft = computed(() =>
  Math.min(props.anchorRect.left, window.innerWidth - 288)
)

onMounted(async () => {
  document.addEventListener('mousedown', onOutsideClick)
  document.addEventListener('keydown', onEscKey)

  try {
    const result = await window.api.invoke('notes:get', { id: props.noteId })
    if (result) {
      note.value = result as NoteRow
    } else {
      failed.value = true
    }
  } catch (err) {
    console.error('[NoteLinkPopup] notes:get error:', err)
    failed.value = true
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutsideClick)
  document.removeEventListener('keydown', onEscKey)
})

function onOutsideClick(e: MouseEvent): void {
  if (popupRef.value && !popupRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

function onEscKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

function openNote(e: MouseEvent): void {
  if (!note.value) return
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: props.noteId, title: note.value.title, mode })
  emit('close')
}
</script>

<template>
  <div
    ref="popupRef"
    class="note-link-popup"
    :style="{ top: `${popupTop}px`, left: `${popupLeft}px` }"
  >
    <template v-if="note">
      <div class="note-link-popup-header">
        <span class="note-link-popup-icon">
          <FileText :size="18" color="#50c0a0" />
        </span>
        <div class="note-link-popup-titles">
          <span class="note-link-popup-name">{{ note.title }}</span>
          <span class="note-link-popup-type">Note</span>
        </div>
        <button class="note-link-popup-open-btn" @click="openNote($event)">Open →</button>
      </div>
    </template>
    <div v-else-if="failed" class="note-link-popup-status">Note not found</div>
    <div v-else class="note-link-popup-status">Loading…</div>
  </div>
</template>

<style scoped>
.note-link-popup {
  position: fixed;
  z-index: 9998;
  width: 280px;
  background: #252525;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  font-size: 13px;
}

.note-link-popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 12px;
}

.note-link-popup-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.note-link-popup-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.note-link-popup-name {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-link-popup-type {
  font-size: 11px;
  color: var(--color-text-muted);
}

.note-link-popup-open-btn {
  flex-shrink: 0;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: #50c0a0;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, border-color 0.1s;
}

.note-link-popup-open-btn:hover {
  background: rgba(80, 192, 160, 0.1);
  border-color: #50c0a0;
}

.note-link-popup-status {
  padding: 16px 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
