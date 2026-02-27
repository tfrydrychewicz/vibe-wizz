import { ref, nextTick, type Ref } from 'vue'

export interface NoteResult {
  id: string
  title: string
}

/**
 * Composable for `[[note link` picking in a plain <textarea>.
 * Works independently of TipTap — handles regex detection, debounced IPC search,
 * keyboard navigation, and text insertion.
 *
 * @param textareaRef - ref to the <textarea> DOM element
 * @param inputText   - ref to the v-model string of the textarea
 * @param afterPick   - optional callback after pick completes (e.g. adjustTextareaHeight)
 */
export function useInputNoteLink(
  textareaRef: Ref<HTMLTextAreaElement | null>,
  inputText: Ref<string>,
  afterPick?: () => void,
) {
  const noteLinkActive = ref(false)
  const noteLinkQuery = ref('')
  const noteLinkStart = ref(-1)
  const noteLinkResults = ref<NoteResult[]>([])
  const noteLinkIndex = ref(0)
  const mentionedNotes = ref<NoteResult[]>([])
  let noteLinkTimer: ReturnType<typeof setTimeout> | null = null

  function close(): void {
    noteLinkActive.value = false
    noteLinkResults.value = []
    noteLinkStart.value = -1
    noteLinkQuery.value = ''
    noteLinkIndex.value = 0
    if (noteLinkTimer) { clearTimeout(noteLinkTimer); noteLinkTimer = null }
  }

  function debouncedSearch(query: string): void {
    if (noteLinkTimer) { clearTimeout(noteLinkTimer); noteLinkTimer = null }
    noteLinkResults.value = []
    noteLinkIndex.value = 0
    noteLinkTimer = setTimeout(async () => {
      try {
        const results = await window.api.invoke('notes:search', { query }) as NoteResult[]
        noteLinkResults.value = results.slice(0, 8)
      } catch {
        noteLinkResults.value = []
      }
    }, 150)
  }

  /**
   * Call on every textarea @input event (only when @ trigger was NOT found first).
   * Returns true if the [[ trigger is active.
   * @param closeOther - close function of the sibling composable (e.g. mention.close)
   */
  function updateState(closeOther?: () => void): boolean {
    const ta = textareaRef.value
    if (!ta) return false
    const val = ta.value
    const pos = ta.selectionStart ?? val.length
    const before = val.slice(0, pos)

    const match = before.match(/\[\[([^\]]*)$/)
    if (match) {
      const newStart = before.length - match[0].length
      const newQuery = match[1]
      const stateChanged = newStart !== noteLinkStart.value || newQuery !== noteLinkQuery.value
      noteLinkStart.value = newStart
      noteLinkQuery.value = newQuery
      noteLinkActive.value = true
      closeOther?.()
      if (stateChanged) debouncedSearch(newQuery)
      return true
    }
    close()
    return false
  }

  function pick(note: NoteResult): void {
    const ta = textareaRef.value
    if (!ta || noteLinkStart.value < 0) return
    const val = ta.value
    const cursorPos = ta.selectionStart ?? val.length
    const inserted = `[[${note.title}]]`
    inputText.value = val.slice(0, noteLinkStart.value) + inserted + val.slice(cursorPos)
    // cap at 5 unique notes per session
    if (mentionedNotes.value.length < 5 && !mentionedNotes.value.find((n) => n.id === note.id)) {
      mentionedNotes.value.push(note)
    }
    const insertEnd = noteLinkStart.value + inserted.length
    close()
    nextTick(() => {
      ta.setSelectionRange(insertEnd, insertEnd)
      ta.focus()
      afterPick?.()
    })
  }

  /**
   * Call on every textarea @keydown event (after @ mention handler returned false).
   * Returns true if the event was consumed.
   */
  function handleKeydown(e: KeyboardEvent): boolean {
    if (!noteLinkActive.value || noteLinkResults.value.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      noteLinkIndex.value = (noteLinkIndex.value + 1) % noteLinkResults.value.length
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      noteLinkIndex.value = (noteLinkIndex.value - 1 + noteLinkResults.value.length) % noteLinkResults.value.length
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const note = noteLinkResults.value[noteLinkIndex.value]
      if (note) pick(note)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return true
    }
    return false
  }

  function removeNote(id: string): void {
    const idx = mentionedNotes.value.findIndex((n) => n.id === id)
    if (idx !== -1) mentionedNotes.value.splice(idx, 1)
  }

  return {
    noteLinkActive,
    noteLinkResults,
    noteLinkIndex,
    mentionedNotes,
    updateState,
    handleKeydown,
    pick,
    close,
    removeNote,
  }
}
