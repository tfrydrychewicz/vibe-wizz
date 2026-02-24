<script setup lang="ts">
import { ref, onMounted, defineExpose } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'

type NoteListItem = {
  id: string
  title: string
  updated_at: string
  created_at: string
}

const props = defineProps<{ activeNoteId: string | null }>()
const emit = defineEmits<{
  select: [id: string]
  'new-note': []
}>()

const notes = ref<NoteListItem[]>([])

async function refresh(): Promise<void> {
  notes.value = (await window.api.invoke('notes:list')) as NoteListItem[]
}

async function deleteNote(id: string): Promise<void> {
  await window.api.invoke('notes:delete', { id })
  await refresh()
  // If the deleted note was active, select the first remaining note
  if (props.activeNoteId === id) {
    if (notes.value.length > 0) {
      emit('select', notes.value[0].id)
    } else {
      emit('select', '')
    }
  }
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
        :class="{ active: note.id === activeNoteId }"
        @click="emit('select', note.id)"
      >
        <div class="note-list-item-body">
          <div class="note-list-item-title">{{ note.title || 'Untitled' }}</div>
          <div class="note-list-item-date">{{ formatDate(note.updated_at) }}</div>
        </div>
        <button
          class="note-list-item-delete"
          title="Delete note"
          @click.stop="deleteNote(note.id)"
        >
          <Trash2 :size="13" />
        </button>
      </div>

      <div v-if="notes.length === 0" class="note-list-empty">
        No notes yet
      </div>
    </div>
  </div>
</template>
