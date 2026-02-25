/**
 * Module-level reactive state for transcription.
 *
 * `pendingAutoStartNoteId` — set by App.vue when the meeting prompt triggers
 * transcription and opens a note. NoteEditor checks this on load and auto-starts
 * recording if it matches the currently-opened note, then clears the ref.
 *
 * Follows the same pattern as mentionStore.ts / noteLinkStore.ts.
 */
import { ref } from 'vue'

/** If set, NoteEditor should auto-start transcription when this note loads. */
export const pendingAutoStartNoteId = ref<string | null>(null)
