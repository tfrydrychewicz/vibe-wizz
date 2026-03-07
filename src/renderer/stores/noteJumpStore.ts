/**
 * noteJumpStore — cross-component signal for "open this note and jump to blocks".
 *
 * Set by ChatSidebar when the user clicks a note-selection chip in the message
 * history. Consumed (and cleared) by NoteEditor after the note finishes loading.
 */

import { ref } from 'vue'

export interface PendingNoteJump {
  noteId: string
  blockStart: number
  blockEnd: number
}

export const pendingNoteJump = ref<PendingNoteJump | null>(null)
