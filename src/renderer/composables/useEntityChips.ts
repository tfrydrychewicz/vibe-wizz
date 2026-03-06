/**
 * useEntityChips — post-render composable that styles inline entity reference
 * chips (.wizz-entity-chip) with the entity type's color and icon.
 *
 * Strategy
 * --------
 * Entity chips are rendered as plain HTML buttons via v-html using the shared
 * renderEntityChip() helper from markdown.ts.  After the DOM is updated, call
 * `applyToElement(container)` to scan for unprocessed chips (marked by absence
 * of [data-chips-applied]).  For each chip we:
 *   1. Resolve the entity type via entityTypeStore (cached IPC call).
 *   2. Apply the type color as inline CSS.
 *   3. Mount a tiny LucideIcon Vue app inside the button for the type icon.
 *
 * All mounted micro-apps are cleaned up in onBeforeUnmount.
 *
 * IMPORTANT: Never add additional selectors here.  All entity chips in the app
 * must use the canonical ENTITY_CHIP_CLASS ('wizz-entity-chip') from markdown.ts.
 */

import { onBeforeUnmount, nextTick } from 'vue'
import { createApp, type App } from 'vue'
import LucideIcon from '../components/LucideIcon.vue'
import { getEntityTypeForId } from '../stores/entityTypeStore'
import { ENTITY_CHIP_CLASS } from '../utils/markdown'

/** Single canonical selector — targets all entity chips across the entire app. */
const CHIP_SELECTOR = `.${ENTITY_CHIP_CLASS}[data-entity-id]:not([data-chips-applied])`

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '')
  if (clean.length !== 6) return null
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ]
}

function applyColor(btn: HTMLButtonElement, color: string): void {
  const rgb = hexToRgb(color)
  if (!rgb) return
  const [r, g, b] = rgb
  btn.style.background = `rgba(${r},${g},${b},0.12)`
  btn.style.color = color
  btn.style.borderColor = `rgba(${r},${g},${b},0.3)`
}

export function useEntityChips() {
  const mountedApps: App[] = []

  async function applyToElement(container: HTMLElement): Promise<void> {
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(CHIP_SELECTOR),
    )
    if (buttons.length === 0) return

    await Promise.all(
      buttons.map(async (btn) => {
        // Mark immediately so concurrent calls don't double-process
        btn.dataset.chipsApplied = '1'

        const entityId = btn.dataset.entityId
        if (!entityId) return

        const type = await getEntityTypeForId(entityId)
        if (!type) return

        const color = type.color ?? '#5b8def'
        applyColor(btn, color)

        // Prepend a tiny icon rendered by a mounted Vue micro-app
        const iconWrapper = document.createElement('span')
        iconWrapper.style.cssText =
          'display:inline-flex;align-items:center;margin-right:3px;vertical-align:middle;line-height:1'
        btn.prepend(iconWrapper)

        const app = createApp(LucideIcon, { name: type.icon, size: 11, color: 'currentColor' })
        app.mount(iconWrapper)
        mountedApps.push(app)
      }),
    )
  }

  /** Convenience: waits for nextTick then applies to the given element. */
  async function applyAfterTick(container: HTMLElement | null | undefined): Promise<void> {
    if (!container) return
    await nextTick()
    await applyToElement(container)
  }

  onBeforeUnmount(() => {
    for (const app of mountedApps) {
      try { app.unmount() } catch { /* already unmounted — ignore */ }
    }
    mountedApps.length = 0
  })

  return { applyToElement, applyAfterTick }
}
