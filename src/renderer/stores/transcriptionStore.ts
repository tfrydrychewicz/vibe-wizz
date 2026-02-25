/**
 * Module-level reactive state for transcription.
 *
 * `pendingAutoStartNoteId` — set by App.vue when the meeting prompt triggers
 * transcription and opens a note. NoteEditor checks this on load and auto-starts
 * recording if it matches the currently-opened note, then clears the ref.
 *
 * `activeTranscriptionNoteId` — set when transcription starts; persists across
 * NoteEditor unmounts so TabBar and other UI can reflect the active session.
 * Cleared when transcription stops or errors.
 *
 * `activeAudio` — browser-side audio capture objects kept alive across NoteEditor
 * unmounts so audio keeps flowing to the main-process WebSocket when the user
 * navigates away from the transcription note.
 *
 * Follows the same pattern as mentionStore.ts / noteLinkStore.ts.
 */
import { ref } from 'vue'

/** If set, NoteEditor should auto-start transcription when this note loads. */
export const pendingAutoStartNoteId = ref<string | null>(null)

/** Note ID currently being transcribed (null when idle). */
export const activeTranscriptionNoteId = ref<string | null>(null)

/**
 * Browser-side audio capture objects. Stored at module scope so they survive
 * NoteEditor unmounts and keep streaming audio to the main process while the
 * user navigates to another note or view.
 */
export const activeAudio = {
  format: null as string | null,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  scriptProcessor: null as ScriptProcessorNode | null,
  context: null as AudioContext | null,
  mediaRecorder: null as MediaRecorder | null,
  mediaStream: null as MediaStream | null,
}
