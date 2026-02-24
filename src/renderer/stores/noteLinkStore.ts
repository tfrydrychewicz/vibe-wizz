import { reactive } from 'vue'

export const noteArchivedStatus = reactive(new Map<string, boolean>())

type ClickFn = (noteId: string, rect: DOMRect) => void
let clickHandler: ClickFn | null = null

export function registerNoteLinkClickHandler(fn: ClickFn): void {
  clickHandler = fn
}

export function fireNoteLinkClick(noteId: string, rect: DOMRect): void {
  clickHandler?.(noteId, rect)
}
