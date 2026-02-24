/**
 * Module-level store for ActionTaskItem NodeViews.
 * Bypasses Vue injection isolation (same pattern as mentionStore.ts / noteLinkStore.ts).
 *
 * - currentNoteId: the note currently open in the active editor pane
 * - promoteHandler: registered by NoteEditor; called when the "Add to dashboard" button
 *   is clicked in an ActionTaskItem NodeView
 */

type PromoteFn = (taskText: string, pos: number) => Promise<void>

let _currentNoteId = ''
let _promoteHandler: PromoteFn | null = null

export function setCurrentNoteId(id: string): void {
  _currentNoteId = id
}

export function getCurrentNoteId(): string {
  return _currentNoteId
}

export function registerPromoteHandler(fn: PromoteFn): void {
  _promoteHandler = fn
}

export function firePromote(taskText: string, pos: number): Promise<void> {
  return _promoteHandler?.(taskText, pos) ?? Promise.resolve()
}
