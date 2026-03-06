<script setup lang="ts">
import { AlignLeft, X } from 'lucide-vue-next'
import type { NoteSelectionAttachment } from '../types/noteSelection'

defineProps<{
  attachment: NoteSelectionAttachment
  /** When false the × remove button is hidden (e.g. in conversation history) */
  removable?: boolean
}>()

const emit = defineEmits<{
  remove: []
}>()
</script>

<template>
  <div class="wizz-note-selection-chip" :title="attachment.selectedText">
    <AlignLeft :size="13" class="wizz-note-selection-chip__icon" />
    <span class="wizz-note-selection-chip__title">{{ attachment.noteTitle }}</span>
    <span class="wizz-note-selection-chip__range">
      (blocks {{ attachment.blockStart }}–{{ attachment.blockEnd }})
    </span>
    <button
      v-if="removable !== false"
      class="wizz-note-selection-chip__remove"
      title="Remove"
      @click.stop="emit('remove')"
    >
      <X :size="10" />
    </button>
  </div>
</template>
