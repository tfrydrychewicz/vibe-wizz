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
 * `processingTranscriptionNoteId` — set when the user stops recording and
 * post-processing (speaker mapping + AI note generation) begins; cleared when
 * `transcription:complete` fires. Used by NoteList to show a wave animation.
 *
 * `processingStep` — human-readable label of the current post-processing step
 * (e.g. "Mapping speakers…", "Generating meeting notes…"). Empty string when idle.
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

/** Note ID whose transcript is currently being post-processed (null when idle). */
export const processingTranscriptionNoteId = ref<string | null>(null)

/** Label of the current post-processing step, e.g. "Generating meeting notes…" */
export const processingStep = ref<string>('')

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
