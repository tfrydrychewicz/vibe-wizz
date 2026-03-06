<script setup lang="ts">
import { FileText } from 'lucide-vue-next'
import type { NoteResult } from '../composables/useInputNoteLink'

/**
 * Shared [[note-link picker dropdown for all textarea-based inputs
 * (ChatSidebar, AIPromptModal, etc.).
 *
 * Keyboard navigation is handled by the useInputNoteLink composable — this
 * component is purely presentational. Uses global .input-picker CSS classes
 * from style.css so the look stays in sync with InputEntityPicker.
 */
defineProps<{
  items: NoteResult[]
  activeIndex: number
}>()

const emit = defineEmits<{
  pick: [note: NoteResult]
}>()
</script>

<template>
  <div class="input-picker input-picker--note">
    <button
      v-for="(note, i) in items"
      :key="note.id"
      class="input-picker-option"
      :class="{ 'input-picker-option--active': i === activeIndex }"
      @mousedown.prevent
      @click="emit('pick', note)"
    >
      <span class="input-picker-icon" style="color: #50c0a0">
        <FileText :size="13" />
      </span>
      <span class="input-picker-name">{{ note.title }}</span>
    </button>
  </div>
</template>
