<script setup lang="ts">
import { ref, onMounted, defineExpose } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import { noteArchivedStatus } from '../stores/noteLinkStore'

type NoteListItem = {
  id: string
  title: string
  updated_at: string
  created_at: string
}

const props = defineProps<{ activeNoteId: string | null }>()
const emit = defineEmits<{
  select: [id: string]
  'open-new-pane': [id: string]
  'open-new-tab': [id: string]
  'new-note': []
  trashed: [id: string]
}>()

function onItemClick(e: MouseEvent, noteId: string): void {
  if (e.metaKey || e.ctrlKey) {
    emit('open-new-tab', noteId)
  } else if (e.shiftKey) {
    emit('open-new-pane', noteId)
  } else {
    emit('select', noteId)
  }
}

const notes = ref<NoteListItem[]>([])

// Confirmation state: { id, count } when pending user confirmation
const pendingTrash = ref<{ id: string; count: number } | null>(null)

async function refresh(): Promise<void> {
  notes.value = (await window.api.invoke('notes:list')) as NoteListItem[]
}

async function requestTrash(id: string): Promise<void> {
  const { count } = (await window.api.invoke('notes:get-link-count', { id })) as { count: number }
  if (count > 0) {
    pendingTrash.value = { id, count }
  } else {
    await finishTrash(id)
  }
}

async function finishTrash(id: string): Promise<void> {
  pendingTrash.value = null
  await window.api.invoke('notes:delete', { id })
  noteArchivedStatus.set(id, true)
  await refresh()
  emit('trashed', id)
  if (props.activeNoteId === id) {
    emit('select', notes.value.length > 0 ? notes.value[0].id : '')
  }
}

function cancelTrash(): void {
  pendingTrash.value = null
}

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

onMounted(refresh)
defineExpose({ refresh })
</script>

<template>
  <div class="note-list-pane">
    <div class="note-list-header">
      <button class="note-list-new-btn" @click="emit('new-note')">
        <Plus :size="14" />
        New Note
      </button>
    </div>

    <div class="note-list-scroll">
      <div
        v-for="note in notes"
        :key="note.id"
        class="note-list-item"
        :class="{ active: note.id === activeNoteId, 'is-confirming': pendingTrash?.id === note.id }"
        @click="pendingTrash?.id === note.id ? undefined : onItemClick($event, note.id)"
      >
        <!-- Trash confirmation overlay -->
        <template v-if="pendingTrash && pendingTrash.id === note.id">
          <div class="trash-confirm" @click.stop>
            <span class="trash-confirm-msg">
              Linked from {{ pendingTrash.count }} {{ pendingTrash.count === 1 ? 'note' : 'notes' }}.
              Move to trash?
            </span>
            <div class="trash-confirm-btns">
              <button class="trash-confirm-yes" @click="finishTrash(note.id)">Move to trash</button>
              <button class="trash-confirm-no" @click="cancelTrash">Cancel</button>
            </div>
          </div>
        </template>

        <template v-else>
          <div class="note-list-item-body">
            <div class="note-list-item-title">{{ note.title || 'Untitled' }}</div>
            <div class="note-list-item-date">{{ formatDate(note.updated_at) }}</div>
          </div>
          <button
            class="note-list-item-delete"
            title="Move to trash"
            @click.stop="requestTrash(note.id)"
          >
            <Trash2 :size="13" />
          </button>
        </template>
      </div>

      <div v-if="notes.length === 0" class="note-list-empty">
        No notes yet
      </div>
    </div>
  </div>
</template>

<style scoped>
.note-list-item.is-confirming {
  cursor: default;
  padding: 0;
}

.trash-confirm {
  width: 100%;
  padding: 10px 10px 10px 12px;
  background: var(--color-surface);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trash-confirm-msg {
  font-size: 12px;
  color: #f06070;
  line-height: 1.4;
}

.trash-confirm-btns {
  display: flex;
  gap: 5px;
}

.trash-confirm-yes,
.trash-confirm-no {
  font-size: 11px;
  font-family: inherit;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  flex: 1;
}

.trash-confirm-yes {
  background: rgba(240, 96, 112, 0.15);
  border: 1px solid rgba(240, 96, 112, 0.5);
  color: #f06070;
}

.trash-confirm-yes:hover {
  background: rgba(240, 96, 112, 0.25);
}

.trash-confirm-no {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.trash-confirm-no:hover {
  color: var(--color-text);
}
</style>
