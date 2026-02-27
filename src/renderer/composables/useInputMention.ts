import { ref, nextTick, type Ref } from 'vue'

export interface EntityResult {
  id: string
  name: string
  type_name: string
}

/**
 * Composable for `@entity` mention picking in a plain <textarea>.
 * Works independently of TipTap — handles regex detection, debounced IPC search,
 * keyboard navigation, and text insertion.
 *
 * @param textareaRef - ref to the <textarea> DOM element
 * @param inputText   - ref to the v-model string of the textarea
 * @param afterPick   - optional callback after pick completes (e.g. adjustTextareaHeight)
 */
export function useInputMention(
  textareaRef: Ref<HTMLTextAreaElement | null>,
  inputText: Ref<string>,
  afterPick?: () => void,
) {
  const mentionActive = ref(false)
  const mentionQuery = ref('')
  const mentionStart = ref(-1)
  const mentionResults = ref<EntityResult[]>([])
  const mentionIndex = ref(0)
  const mentionedEntities = ref<EntityResult[]>([])
  let mentionTimer: ReturnType<typeof setTimeout> | null = null

  function close(): void {
    mentionActive.value = false
    mentionResults.value = []
    mentionStart.value = -1
    mentionQuery.value = ''
    mentionIndex.value = 0
    if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null }
  }

  function debouncedSearch(query: string): void {
    if (mentionTimer) { clearTimeout(mentionTimer); mentionTimer = null }
    mentionResults.value = []
    mentionIndex.value = 0
    mentionTimer = setTimeout(async () => {
      try {
        const results = await window.api.invoke('entities:search', { query }) as EntityResult[]
        mentionResults.value = results.slice(0, 8)
      } catch {
        mentionResults.value = []
      }
    }, 150)
  }

  /**
   * Call on every textarea @input event.
   * Returns true if the @ trigger is active (caller should skip other picker checks).
   * @param closeOther - close function of the sibling composable (e.g. noteLink.close)
   */
  function updateState(closeOther?: () => void): boolean {
    const ta = textareaRef.value
    if (!ta) return false
    const val = ta.value
    const pos = ta.selectionStart ?? val.length
    const before = val.slice(0, pos)

    const atMatch = before.match(/@([^\s@]*)$/)
    if (atMatch) {
      const newStart = before.length - atMatch[0].length
      const newQuery = atMatch[1]
      const stateChanged = newStart !== mentionStart.value || newQuery !== mentionQuery.value
      mentionStart.value = newStart
      mentionQuery.value = newQuery
      mentionActive.value = true
      closeOther?.()
      if (stateChanged) debouncedSearch(newQuery)
      return true
    }
    close()
    return false
  }

  function pick(entity: EntityResult): void {
    const ta = textareaRef.value
    if (!ta || mentionStart.value < 0) return
    const val = ta.value
    const cursorPos = ta.selectionStart ?? val.length
    inputText.value = val.slice(0, mentionStart.value) + `@${entity.name}` + val.slice(cursorPos)
    if (!mentionedEntities.value.find((e) => e.id === entity.id)) {
      mentionedEntities.value.push(entity)
    }
    const insertEnd = mentionStart.value + entity.name.length + 1
    close()
    nextTick(() => {
      ta.setSelectionRange(insertEnd, insertEnd)
      ta.focus()
      afterPick?.()
    })
  }

  /**
   * Call on every textarea @keydown event (before other key handling).
   * Returns true if the event was consumed (caller should stop further processing).
   */
  function handleKeydown(e: KeyboardEvent): boolean {
    if (!mentionActive.value || mentionResults.value.length === 0) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mentionIndex.value = (mentionIndex.value + 1) % mentionResults.value.length
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      mentionIndex.value = (mentionIndex.value - 1 + mentionResults.value.length) % mentionResults.value.length
      return true
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const entity = mentionResults.value[mentionIndex.value]
      if (entity) pick(entity)
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return true
    }
    return false
  }

  function removeEntity(id: string): void {
    const idx = mentionedEntities.value.findIndex((e) => e.id === id)
    if (idx !== -1) mentionedEntities.value.splice(idx, 1)
  }

  return {
    mentionActive,
    mentionResults,
    mentionIndex,
    mentionedEntities,
    updateState,
    handleKeydown,
    pick,
    close,
    removeEntity,
  }
}
