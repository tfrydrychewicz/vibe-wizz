/**
 * Represents a range of content the user selected and copied from a note editor.
 * Written to the clipboard as `application/x-wizz-note-selection` JSON alongside
 * the normal `text/plain` payload.  On paste in ChatSidebar or AIPromptModal this
 * becomes a chip in the UI; the `selectedText` is injected into the AI prompt as a
 * labelled context block.
 */
export interface NoteSelectionAttachment {
  /** ULID of the source note */
  noteId: string
  /** Title of the source note at copy time */
  noteTitle: string
  /** 1-based index of the first top-level block node that overlaps the selection */
  blockStart: number
  /** 1-based index of the last top-level block node that overlaps the selection */
  blockEnd: number
  /**
   * Plain-text rendering of the selected content.
   * Block nodes separated by newlines; task items serialised with their checkbox
   * state (e.g. "- [ ] Task title" / "- [x] Done task").
   */
  selectedText: string
}

/** MIME type used to carry a NoteSelectionAttachment in the system clipboard. */
export const NOTE_SELECTION_MIME = 'application/x-wizz-note-selection'
