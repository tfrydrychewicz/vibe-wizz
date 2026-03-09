/**
 * Lazy loader for Excalidraw + React.
 *
 * All three packages (react, react-dom/client, @excalidraw/excalidraw) are
 * dynamically imported the first time the edit modal opens, then cached in
 * module scope. View mode (SVG preview) never triggers this load.
 *
 * The Excalidraw CSS is imported statically so Vite bundles it at build time —
 * it is small and needed as soon as the canvas mounts.
 */

// Static CSS import — Vite bundles this; no runtime cost.
import '@excalidraw/excalidraw/index.css'

import type {
  ExcalidrawElement,
  OrderedExcalidrawElement,
} from '@excalidraw/excalidraw/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types'

export type { ExcalidrawElement, OrderedExcalidrawElement, AppState, BinaryFiles }

/** Subset of ExcalidrawProps we actually use. */
export interface ExcalidrawComponentProps {
  initialData?: {
    elements?: readonly ExcalidrawElement[]
    appState?: Partial<AppState>
    files?: BinaryFiles
  }
  theme?: 'light' | 'dark'
  onChange?: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void
  excalidrawAPI?: (api: ExcalidrawImperativeAPI) => void
}

/** Minimal slice of the imperative API we need (for future use). */
export interface ExcalidrawImperativeAPI {
  getSceneElements: () => readonly ExcalidrawElement[]
  getAppState: () => AppState
  getFiles: () => BinaryFiles
}

/** Shape returned by loadExcalidraw(). */
export interface LoadedExcalidraw {
  /** The Excalidraw React component (typed as `unknown` to avoid React type leakage into Vue). */
  ExcalidrawComponent: unknown
  /** Generate an SVG from scene data. */
  exportToSvg: (opts: {
    elements: readonly ExcalidrawElement[]
    appState?: Partial<AppState>
    files?: BinaryFiles | null
    exportWithDarkMode?: boolean
    exportPadding?: number
  }) => Promise<SVGSVGElement>
  /** React.createElement — used to mount the component imperatively. */
  createElement: (
    type: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    props?: Record<string, any> | null,
    ...children: unknown[]
  ) => unknown
  /** ReactDOM.createRoot — used to mount into a plain DOM element. */
  createRoot: (container: Element) => ReactRoot
}

export interface ReactRoot {
  render(element: unknown): void
  unmount(): void
}

// ─── Session-only auto-open flag ──────────────────────────────────────────────
// Used instead of a TipTap node attribute so the "open editor immediately after
// creation" intent is never persisted to the database.

let _pendingAutoOpen = false

/** Called by the slash-command handler right before inserting a new node. */
export function requestExcalidrawAutoOpen(): void {
  _pendingAutoOpen = true
}

/**
 * Called once in ExcalidrawView's onMounted.
 * Returns true (and clears the flag) when the editor should open automatically.
 */
export function consumeExcalidrawAutoOpen(): boolean {
  const v = _pendingAutoOpen
  _pendingAutoOpen = false
  return v
}

// ─── Module-level cache ───────────────────────────────────────────────────────

let cached: LoadedExcalidraw | null = null

/**
 * Dynamically imports React + Excalidraw on first call, then returns the
 * cached result on all subsequent calls. Safe to call multiple times.
 */
export async function loadExcalidraw(): Promise<LoadedExcalidraw> {
  if (cached) return cached

  const [excalidrawPkg, reactPkg, reactDomPkg] = await Promise.all([
    import('@excalidraw/excalidraw'),
    import('react'),
    import('react-dom/client'),
  ])

  cached = {
    ExcalidrawComponent: excalidrawPkg.Excalidraw,
    exportToSvg: excalidrawPkg.exportToSvg as LoadedExcalidraw['exportToSvg'],
    createElement: reactPkg.createElement as unknown as LoadedExcalidraw['createElement'],
    createRoot: reactDomPkg.createRoot as unknown as LoadedExcalidraw['createRoot'],
  }

  return cached
}
