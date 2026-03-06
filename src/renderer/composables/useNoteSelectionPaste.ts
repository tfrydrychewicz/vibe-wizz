import { ref } from 'vue'
import type { Ref } from 'vue'
import { NOTE_SELECTION_MIME, type NoteSelectionAttachment } from '../types/noteSelection'

/**
 * Composable for intercepting paste events that carry a Wizz note selection
 * (written by `NoteEditor.onEditorCopy` as `application/x-wizz-note-selection`).
 *
 * Usage (ChatSidebar, AIPromptModal, or any future input surface):
 *
 *   const { attachedSelections, onPaste, removeSelection, clear } = useNoteSelectionPaste()
 *
 *   // In the paste handler — call BEFORE useFileAttachment().onPaste so Wizz
 *   // clipboard data is intercepted first:
 *   function handlePaste(e: ClipboardEvent): void {
 *     if (noteSelectionPaste.onPaste(e)) return   // handled — skip generic paste
 *     fileAttachment.onPaste(e)
 *   }
 */
export function useNoteSelectionPaste(): {
  attachedSelections: Ref<NoteSelectionAttachment[]>
  onPaste: (e: ClipboardEvent) => boolean
  removeSelection: (index: number) => void
  clear: () => void
} {
  const attachedSelections = ref<NoteSelectionAttachment[]>([])

  /**
   * Call from a `paste` event handler.
   * Returns `true` and calls `e.preventDefault()` when a note selection was found
   * in the clipboard data and added to `attachedSelections`.
   * Returns `false` (and does nothing) when the clipboard carries no Wizz selection,
   * allowing the caller to fall through to generic paste handling.
   */
  function onPaste(e: ClipboardEvent): boolean {
    const raw = e.clipboardData?.getData(NOTE_SELECTION_MIME)
    if (!raw) return false

    try {
      const attachment = JSON.parse(raw) as NoteSelectionAttachment

      // Basic sanity-check — reject malformed payloads
      if (
        typeof attachment.noteId !== 'string' ||
        typeof attachment.noteTitle !== 'string' ||
        typeof attachment.blockStart !== 'number' ||
        typeof attachment.blockEnd !== 'number' ||
        typeof attachment.selectedText !== 'string'
      ) {
        return false
      }

      attachedSelections.value.push(attachment)
      e.preventDefault()
      return true
    } catch {
      return false
    }
  }

  function removeSelection(index: number): void {
    attachedSelections.value.splice(index, 1)
  }

  function clear(): void {
    attachedSelections.value = []
  }

  return { attachedSelections, onPaste, removeSelection, clear }
}
