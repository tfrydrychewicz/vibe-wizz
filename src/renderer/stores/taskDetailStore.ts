/**
 * Module-level store for task detail panel.
 * Bypasses Vue injection isolation (same pattern as mentionStore.ts / taskActionStore.ts).
 *
 * - fireOpenDetail(taskId): triggers TaskDetailPanel to open with that task
 * - registerOpenHandler / fireOpenDetail: called from TaskCard, ActionsView, etc.
 */

type OpenDetailFn = (taskId: string) => void

let _openHandler: OpenDetailFn | null = null

export function registerOpenDetailHandler(fn: OpenDetailFn): void {
  _openHandler = fn
}

export function fireOpenDetail(taskId: string): void {
  _openHandler?.(taskId)
}
