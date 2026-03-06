/**
 * Module-level store for the TaskInlineDetail popup and task data cache.
 * Bypasses Vue injection isolation (same pattern as mentionStore.ts).
 *
 * - taskDataCache: reactive Map populated by NoteEditor on load / push events
 *   so ActionTaskItem NodeViews can read status/project/due without extra fetches.
 * - fireShowInlineDetail: opens the TaskInlineDetail popup at a given anchor
 * - fireUnlink: called by TaskInlineDetail to clear the actionId from the TipTap node
 */

import { reactive } from 'vue'

export interface TaskSummary {
  title: string
  status: 'open' | 'in_progress' | 'done' | 'cancelled' | 'someday'
  project_name: string | null
  due_date: string | null
}

/** Populated by NoteEditor; read by ActionTaskItem NodeViews. */
export const taskDataCache = reactive(new Map<string, TaskSummary>())

/**
 * IDs of action items currently being processed by AI derive-attributes.
 * ActionTaskItem shows a spinner for these IDs instead of the status dot.
 */
export const derivingIds = reactive(new Set<string>())

type ShowFn = (actionId: string, rect: DOMRect) => void
type UnlinkFn = (actionId: string) => void

let _showHandler: ShowFn | null = null
let _unlinkHandler: UnlinkFn | null = null

export function registerShowInlineDetailHandler(fn: ShowFn): void {
  _showHandler = fn
}

export function fireShowInlineDetail(actionId: string, rect: DOMRect): void {
  _showHandler?.(actionId, rect)
}

export function registerUnlinkHandler(fn: UnlinkFn): void {
  _unlinkHandler = fn
}

export function fireUnlink(actionId: string): void {
  _unlinkHandler?.(actionId)
}
