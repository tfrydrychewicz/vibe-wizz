import { reactive } from 'vue'

export const entityTrashStatus = reactive(new Map<string, boolean>())

type ClickFn = (entityId: string, rect: DOMRect) => void
let clickHandler: ClickFn | null = null

export function registerMentionClickHandler(fn: ClickFn): void {
  clickHandler = fn
}

export function fireMentionClick(entityId: string, rect: DOMRect): void {
  clickHandler?.(entityId, rect)
}
