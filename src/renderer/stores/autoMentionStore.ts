import { ref } from 'vue'

export type AutoDetection = {
  entityId: string
  entityName: string
  typeId: string
  typeName: string
  typeIcon: string
  typeColor: string | null
  confidence: number
}

export type HoveredAutoDetection = AutoDetection & {
  /** ProseMirror document position for the start of the matched text span. */
  from: number
  /** ProseMirror document position for the end of the matched text span. */
  to: number
  anchorRect: DOMRect
}

export const hoveredAutoDetection = ref<HoveredAutoDetection | null>(null)

let _hideTimer: ReturnType<typeof setTimeout> | null = null

export function setHoveredAutoDetection(d: HoveredAutoDetection): void {
  if (_hideTimer) {
    clearTimeout(_hideTimer)
    _hideTimer = null
  }
  hoveredAutoDetection.value = d
}

export function scheduleHideAutoDetection(delay = 150): void {
  if (_hideTimer) clearTimeout(_hideTimer)
  _hideTimer = setTimeout(() => {
    hoveredAutoDetection.value = null
    _hideTimer = null
  }, delay)
}

export function cancelHideAutoDetection(): void {
  if (_hideTimer) {
    clearTimeout(_hideTimer)
    _hideTimer = null
  }
}
