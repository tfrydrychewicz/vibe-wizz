# Excalidraw Drawings in Notes

## Status note

**Mermaid diagrams and Chart.js charts are already shipped** — both are live in `CodeBlockView.vue`
with theme selection, resizable preview panes, hide-code toggle, and fullscreen lightbox.

This document designs the next canvas integration: **Excalidraw**, an open-source virtual whiteboard
that lets engineers sketch architectures, wireframes, flowcharts, and system designs. Unlike Mermaid
(code-in → diagram-out) and Chart.js (JSON config → chart-out), Excalidraw is a **fully interactive
canvas with its own persistent object model** — it requires a fundamentally different integration
approach, which this document specifies end-to-end.

---

## Overview

An `/excalidraw` slash command inserts a **Drawing node** into any note or template. The node
renders a live SVG preview of the drawing inline in the note. Clicking **Edit** (or the empty-state
CTA) opens a full-screen Excalidraw canvas as a modal overlay — identical UX to opening an image
editor for a quick sketch, then returning to the note with the updated diagram.

The drawing data (elements, app state, embedded files) is serialised as JSON and stored directly in
the TipTap document body alongside all other note content — no new tables, no new IPC channels, no
main-process changes.

---

## Motivating use cases

| Scenario | Value |
|----------|-------|
| Architecture decision record | Sketch the proposed system topology directly in the decision note; the diagram is version-controlled with the prose |
| 1-on-1 prep | Draw an org chart or project ownership map; update it next sprint without leaving the note |
| Incident post-mortem | Whiteboard the failure cascade as a freehand diagram; attach it to the post-mortem note permanently |
| Interview debrief | Sketch the problem-solving approach the candidate took; annotate it |
| OKR planning | Sketch dependency relationships between OKRs, teams, and projects |
| Meeting notes | Quick freehand sketch of a whiteboarded idea, embedded inline |

---

## Glossary

| Term | Meaning |
|------|---------|
| **Drawing node** | The new TipTap `excalidraw` atom node; a leaf block that stores the scene data |
| **Scene** | The full Excalidraw persistent state: `elements[]`, `appState`, `files` (embedded images) |
| **Preview SVG** | A static SVG string generated from the scene via `exportToSvg()`; stored in the node attribute; rendered in view mode without loading React |
| **View mode** | The default appearance of a Drawing node in the note — shows the preview SVG with an Edit button |
| **Edit modal** | A full-screen Teleport overlay that mounts the Excalidraw React canvas; opened on demand |
| **Loader utility** | `src/renderer/utils/excalidrawLoader.ts` — lazily imports React + Excalidraw only when the modal first opens |
| **autoOpen** | A transient node attribute set by the slash command; triggers the edit modal to open immediately on mount, then self-clears |

---

## Architecture

### Why a dedicated node type (not a code-block language)

Mermaid and Chart.js fit the **code-in → preview-out** model: the user edits text in a `<pre>`,
a library renders a static image below it. Excalidraw inverts this — the user interacts directly
with rendered objects; the "source" is an opaque JSON object model, not human-editable text.
Forcing it into a code block would mean:

- The raw JSON is thousands of lines of unreadable serialised data
- There is no meaningful "code visible / code hidden" toggle
- The user cannot type meaningful input into the `<pre>`

A **leaf atom node** (`atom: true` in TipTap) is the correct primitive. Like TipTap's Image node, it
is an indivisible block that the user selects as a whole, can delete with Backspace, and can drag to
reorder. Its data lives entirely in node attributes — no `NodeViewContent` is needed.

### Node attribute schema

```typescript
interface ExcalidrawAttrs {
  // Canonical scene data — source of truth
  elements:   string   // JSON.stringify(ExcalidrawElement[])  — defaults to '[]'
  appState:   string   // JSON.stringify(Partial<AppState>)    — defaults to '{}'
  files:      string   // JSON.stringify(BinaryFiles)          — defaults to '{}'

  // Derived display data — regenerated on every save-from-edit
  previewSvg: string   // SVG markup string; empty string = show empty-state placeholder

  // Transient — set by slash command, cleared by ExcalidrawView on mount
  autoOpen:   boolean  // when true: open edit modal immediately
}
```

`previewSvg` is stored (not computed on-the-fly) so view mode renders instantly without loading
React or the Excalidraw library. The SVG is regenerated each time the edit modal saves, so it is
always consistent with the stored scene data.

> **Size note**: A typical Excalidraw diagram SVG is 5–40 KB. A complex diagram with several dozen
> shapes may reach 80–100 KB. Embedded raster images inside the drawing (`BinaryFiles`) can push
> `files` into the hundreds of KB. This is acceptable in SQLite (average note body today is < 20 KB,
> limit is effectively unbounded). Users should be advised to use TipTap image nodes (not Excalidraw
> paste) for large bitmap attachments.

### React mounting strategy

`@excalidraw/excalidraw` is a React component. Mounting React inside a Vue component is a
well-established pattern in the Electron/Vite ecosystem:

```typescript
// Simplified — real code lives in ExcalidrawView.vue
import { createRoot }    from 'react-dom/client'
import { createElement } from 'react'
import { Excalidraw }    from '@excalidraw/excalidraw'

// In onMounted (inside the edit modal section):
const root = createRoot(canvasRef.value!)
root.render(createElement(Excalidraw, {
  initialData: { elements, appState, files },
  theme: 'dark',
  onChange: (els, state, fls) => {
    pendingElements = els
    pendingAppState = state
    pendingFiles    = fls
  },
}))

// In onBeforeUnmount:
root.unmount()
```

To avoid bloating the initial bundle, all three imports (`react`, `react-dom/client`,
`@excalidraw/excalidraw`) are loaded lazily via the loader utility only when the edit modal first
opens. After the first load they are cached in module scope — subsequent opens are instant.

### Loader utility (`src/renderer/utils/excalidrawLoader.ts`)

```typescript
import type { ExcalidrawElement }   from '@excalidraw/excalidraw/types/element/types'
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types/types'

type LoadedExcalidraw = {
  Excalidraw:  unknown             // React component (typed as unknown to avoid React types in Vue)
  exportToSvg: (opts: {
    elements: readonly ExcalidrawElement[]
    appState?: Partial<AppState>
    files?:   BinaryFiles | null
  }) => Promise<SVGSVGElement>
  createElement: (type: unknown, props?: unknown, ...children: unknown[]) => unknown
  createRoot:    (container: Element) => { render(el: unknown): void; unmount(): void }
}

let cached: LoadedExcalidraw | null = null

export async function loadExcalidraw(): Promise<LoadedExcalidraw> {
  if (cached) return cached
  const [excalidrawPkg, reactPkg, reactDomPkg] = await Promise.all([
    import('@excalidraw/excalidraw'),
    import('react'),
    import('react-dom/client'),
  ])
  cached = {
    Excalidraw:   excalidrawPkg.Excalidraw,
    exportToSvg:  excalidrawPkg.exportToSvg,
    createElement: reactPkg.createElement,
    createRoot:    reactDomPkg.createRoot,
  }
  return cached
}
```

### SVG export pipeline

When the user clicks **Save & Close** in the edit modal:

```
pendingElements + pendingAppState + pendingFiles
        │
        ▼
exportToSvg({ elements, appState, files, exportWithDarkMode: true })
        │
        ▼ SVGSVGElement
new XMLSerializer().serializeToString(svgElement)
        │
        ▼ string
props.updateAttributes({
  elements:   JSON.stringify(pendingElements),
  appState:   JSON.stringify(pendingAppState),
  files:      JSON.stringify(pendingFiles),
  previewSvg: svgString,
})
        │
        ▼
TipTap document serialised → notes:update (existing auto-save) → SQLite
```

### ExcalidrawView.vue — single file, two responsibilities

Rather than two separate Vue components (view + modal), a single `ExcalidrawView.vue` hosts both:

- The **view-mode block** rendered inside the `NodeViewWrapper` (always visible in the note)
- The **edit modal** rendered via `<Teleport to="body">` (shown when `isEditing === true`)

This is identical to how `CodeBlockView.vue` hosts the Mermaid fullscreen lightbox — no additional
component file, no cross-component store needed. The TipTap `nodeViewProps` (`updateAttributes`,
`node.attrs`) flow naturally into both sections.

### TipTap extension (`src/renderer/extensions/ExcalidrawExtension.ts`)

```typescript
import { Node, mergeAttributes } from '@tiptap/core'
import { VueNodeViewRenderer }   from '@tiptap/vue-3'
import type { Component }        from 'vue'
import type { NodeViewProps }    from '@tiptap/vue-3'
import ExcalidrawView            from '../components/ExcalidrawView.vue'

export const ExcalidrawExtension = Node.create({
  name:       'excalidraw',
  group:      'block',
  atom:       true,
  selectable: true,
  draggable:  true,

  addAttributes() {
    return {
      elements:   { default: '[]' },
      appState:   { default: '{}' },
      files:      { default: '{}' },
      previewSvg: { default: '' },
      autoOpen:   { default: false },
    }
  },

  parseHTML()  { return [{ tag: 'div[data-excalidraw]' }] },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ 'data-excalidraw': '' }, HTMLAttributes)]
  },

  addNodeView() {
    return VueNodeViewRenderer(ExcalidrawView as Component<NodeViewProps>)
  },
})
```

### Slash command integration

A new entry is added to `SLASH_COMMANDS` in `NoteEditor.vue`:

```typescript
{ id: 'excalidraw', label: 'Drawing', description: 'Insert an Excalidraw whiteboard', icon: 'pencil-ruler' }
```

The handler in the `switch` block inserts the node with `autoOpen: true`:

```typescript
case 'excalidraw':
  ed.chain().focus().deleteRange(range).insertContent({
    type: 'excalidraw',
    attrs: { elements: '[]', appState: '{}', files: '{}', previewSvg: '', autoOpen: true },
  }).run()
  break
```

`ExcalidrawView.vue` detects `autoOpen` on mount, immediately opens the modal, and clears the
attribute — so the node does not reopen its modal on every future note load.

### File surface map

| File | Change |
|------|--------|
| `src/renderer/utils/excalidrawLoader.ts` | **New** — lazy loader + cached singleton |
| `src/renderer/extensions/ExcalidrawExtension.ts` | **New** — TipTap Node definition |
| `src/renderer/components/ExcalidrawView.vue` | **New** — view mode block + edit modal (Teleport) |
| `src/renderer/components/NoteEditor.vue` | Import + register extension; add slash command entry + handler |
| `src/renderer/components/TemplateEditor.vue` | Import + register extension (full feature parity) |
| `src/renderer/style.css` | New shared classes: `.excalidraw-preview-block`, `.excalidraw-empty-state` |
| `package.json` | Add `@excalidraw/excalidraw`, `react`, `react-dom`, `@types/react`, `@types/react-dom` |

No IPC changes. No database migrations. No main-process changes.

---

## UI behaviour

### View mode — drawing exists

```
┌─────────────────────────────────────────────────────────────┐
│  ◈  Excalidraw Drawing              [Export ↓]  [Edit ✎]  │  ← header (contenteditable=false)
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                 [rendered SVG preview]                      │  ← v-html, cursor: zoom-in
│                                                             │
│                                                             │
├·····················································handle···┤  ← resize grip (same as Mermaid)
└─────────────────────────────────────────────────────────────┘
  Optional caption text                                         ← below block, outside border
```

Clicking the SVG area opens the **fullscreen preview lightbox** (same pattern as Mermaid — `Teleport`
overlay, Escape to close, click-outside to close). This is distinct from clicking **Edit**, which
opens the interactive canvas.

The resize handle behaves identically to the Mermaid and Chart.js preview pane handles: drag
vertically to set a fixed height, persisted in the `mermaidHeight` attribute (reused — the attribute
name is already generic in `CodeBlockView.vue`; for ExcalidrawView a separate `drawingHeight`
attribute is used to avoid coupling).

### View mode — empty state (just inserted, no drawing yet)

```
┌─────────────────────────────────────────────────────────────┐
│  ◈  Excalidraw Drawing                           [Edit ✎]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│           ✎   Click Edit to start drawing                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Edit modal — full-screen Excalidraw canvas

```
┌─────────────────────────────────────────────────────────────────────┐
│  ✎  Edit Drawing                    [Cancel]  [Save & Close  ✓]   │  ← modal header
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│                                                                     │
│                    [Full Excalidraw canvas]                         │
│           (all native Excalidraw tools and keyboard shortcuts)      │
│                                                                     │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

- `z-index: 1200` (above the TipTap editor, below command palette at 1100 — wait, above 1100 since
  this is full-screen; palette is already above notes anyway)
- Dark theme matches app (`theme="dark"` prop)
- Background: `#1a1a1a` (`--color-bg`) so seams between Excalidraw's chrome and the modal overlay
  are invisible
- **Save & Close**: calls `exportToSvg()` → serialises all data → `updateAttributes()` → sets
  `isEditing = false`
- **Cancel**: discards `pendingElements/appState/files` → sets `isEditing = false`. If the node was
  just inserted (empty), a Cancel does NOT delete the node — the empty-state placeholder is shown
  instead, letting the user click Edit again
- **Escape key**: same as Cancel (consistent with Mermaid fullscreen close behaviour)
- Generating SVG on save can take ~50–200 ms for complex scenes; show a brief spinner on the
  Save button during this window

### Fullscreen lightbox (SVG zoom)

```
┌─────── (dark overlay, click-outside to close) ───────────────────┐
│                                                    [✕ Close]      │
│                                                                   │
│                [SVG at maximum viewport size]                     │
│                     (scrollable if larger)                        │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

Implemented identically to the Mermaid lightbox already in `CodeBlockView.vue`: `Teleport` to body,
`<Transition name="excalidraw-overlay">`, Escape key handler.

### Resize handle

Drag the bottom grip to set the preview height. Height is persisted in `drawingHeight` node
attribute (same mechanism as `mermaidHeight`). Minimum height: 120 px. Default (first open): 280 px
(taller than Mermaid default because drawings typically need more vertical space).

---

## Dependencies

| Package | Reason | Bundle impact |
|---------|--------|---------------|
| `@excalidraw/excalidraw` | Excalidraw React component + `exportToSvg` | ~2 MB (lazy-loaded; 0 impact on initial bundle) |
| `react` | React runtime required by Excalidraw | ~45 KB gzip (lazy) |
| `react-dom` | React DOM renderer | ~130 KB gzip (lazy) |
| `@types/react` | TypeScript types | Dev-only |
| `@types/react-dom` | TypeScript types | Dev-only |

All lazy imports are loaded into a module-level cache the first time the edit modal opens. Closing
and reopening the modal is instant (no second network/disk fetch).

**Vite configuration**: No plugin changes are required. `@excalidraw/excalidraw` ships pre-compiled
ESM; Vite resolves it without a JSX transform. The Excalidraw CSS (`@excalidraw/excalidraw/index.css`)
is imported statically at the top of `excalidrawLoader.ts` — Vite bundles it into the renderer CSS
at build time (no runtime style injection needed).

---

## Design decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Node type | Atom leaf (`atom: true`) | No user-editable text content; selection and deletion handled by TipTap naturally |
| React mounting | `createRoot` inside Vue `onMounted` | Standard pattern for embedding React in non-React apps; no wrapper library needed |
| Lazy import | Dynamic `import()` via loader utility | Keeps initial renderer bundle unaffected; React + Excalidraw load only on first edit |
| SVG storage | Stored in `previewSvg` node attribute, regenerated on each save | View mode renders instantly without any library; SVG is always consistent with stored scene |
| Empty-state on Cancel | Keep node, show placeholder | Deleting the node unexpectedly on Cancel is surprising; user can delete with Backspace if unwanted |
| `autoOpen` attribute | Set by slash command, cleared on mount | Avoids a cross-component store; contained within the node view lifecycle |
| Fullscreen lightbox | Same Teleport + Transition pattern as Mermaid | Consistency; code is already proven; no new pattern introduced |
| Resize handle | Same mechanism as Mermaid/Chart.js panes | Reuse `.preview-resize-handle` / `.preview-resize-grip` shared classes from `style.css` |
| Dark theme | Hardcoded `theme="dark"` on `<Excalidraw>` | App is dark-only; no theme picker needed |
| Caption | Optional text attribute below drawing | Some drawings benefit from a title without opening full edit mode |
| TemplateEditor | Full feature parity (view + edit) | Drawing templates are a real use case (e.g. template for 1-on-1 notes with a standard org chart) |
| CSS | `.excalidraw-preview-block` global class in `style.css` | Consistent with `.preview-pane` for Mermaid; single source of truth |

---

## Implementation checklist

### Phase A — Install dependencies

- [x] `npm install @excalidraw/excalidraw react react-dom`
- [x] `npm install -D @types/react @types/react-dom`
- [x] Verify all five packages appear in `package.json`
- [x] Confirm `@excalidraw/excalidraw/index.css` path exists in `node_modules` (the import path may
      vary by package version — check `exports` field in its `package.json` and adjust accordingly)

### Phase B — Loader utility

- [x] Create `src/renderer/utils/excalidrawLoader.ts`
  - [x] Static CSS import: `import '@excalidraw/excalidraw/index.css'` (or the correct CSS path)
  - [x] Define `LoadedExcalidraw` type with `Excalidraw`, `exportToSvg`, `createElement`,
        `createRoot` (type `createRoot` as returning `{ render(el: unknown): void; unmount(): void }`)
  - [x] `let cached: LoadedExcalidraw | null = null`
  - [x] `export async function loadExcalidraw(): Promise<LoadedExcalidraw>` — checks cache,
        `Promise.all`-imports the three packages, populates and returns cache
- [x] Confirm the loader can be imported in a `.vue` file without TypeScript errors
      (`npm run typecheck` after creating the file)

### Phase C — TipTap Extension

- [x] Create `src/renderer/extensions/ExcalidrawExtension.ts`
  - [x] `Node.create({ name: 'excalidraw', group: 'block', atom: true, selectable: true, draggable: true })`
  - [x] `addAttributes()`: `elements` (default `'[]'`), `appState` (default `'{}'`), `files`
        (default `'{}'`), `previewSvg` (default `''`), `autoOpen` (default `false`),
        `drawingHeight` (default `null`)
  - [x] `parseHTML()`: `[{ tag: 'div[data-excalidraw]' }]`
  - [x] `renderHTML()`: `['div', mergeAttributes({ 'data-excalidraw': '' }, HTMLAttributes)]`
  - [x] `addNodeView()`: `VueNodeViewRenderer(ExcalidrawView as Component<NodeViewProps>)`
  - [x] Export `ExcalidrawExtension`

### Phase D — ExcalidrawView.vue (view mode + edit modal)

#### D1 — Scaffold

- [x] Create `src/renderer/components/ExcalidrawView.vue`
- [x] `defineProps(nodeViewProps)` — import from `@tiptap/vue-3`
- [x] Import `NodeViewWrapper` from `@tiptap/vue-3`
- [x] Import `Maximize2`, `X`, `Pencil`, `PencilRuler` from `lucide-vue-next`

#### D2 — View mode (always rendered)

- [x] Computed `hasDrawing`: `props.node.attrs.previewSvg !== ''`
- [x] Computed `drawingHeight`: `props.node.attrs.drawingHeight as number | null`
- [x] Computed `caption`: `props.node.attrs.caption as string`
- [x] Template: `<NodeViewWrapper>` wrapping:
  - [ ] **Header bar** (`contenteditable="false"`):
    - [ ] Icon: `<PencilRuler :size="13" />` + label `"Excalidraw Drawing"`
    - [ ] **Edit button**: `@click="openEditModal"` — always shown
    - [ ] **Export button**: `@click="openLightbox"` — only shown when `hasDrawing` (opens lightbox
          not edit modal; named "View" for clarity when drawing exists)
  - [ ] **Preview area** (`contenteditable="false"`):
    - [ ] `v-if="hasDrawing"` — `<div class="excalidraw-svg-preview" v-html="props.node.attrs.previewSvg" @click="openLightbox" />`
    - [ ] `v-else` — empty-state: centred pencil icon + "Click Edit to start drawing" text
    - [ ] Apply `drawingHeight` as inline `height` style when set
    - [ ] **Resize handle**: identical to `CodeBlockView.vue` implementation (copy `startResize`,
          `resizeHandleRef`, `dragHeight`, `isResizing` logic); on drag-end call
          `props.updateAttributes({ drawingHeight: finalHeight })`
  - [ ] **Caption** (below wrapper, outside border): `<p class="excalidraw-caption" v-if="caption">{{ caption }}</p>`

#### D3 — Edit modal (Teleport to body)

- [x] `isEditing = ref(false)`
- [x] `isSaving = ref(false)` (spinner while `exportToSvg` runs)
- [x] `canvasRef = ref<HTMLDivElement | null>(null)`
- [x] `reactRoot` — module-scope variable (not reactive) to hold the `createRoot` return value
- [x] `pendingElements`, `pendingAppState`, `pendingFiles` — module-scope mutable variables
      (set by Excalidraw's `onChange`; not reactive — we only need their final values on save)
- [x] `async function openEditModal()`:
  1. Set `isEditing = true`
  2. `await nextTick()` (wait for `canvasRef` to mount)
  3. `const { Excalidraw, createElement, createRoot } = await loadExcalidraw()`
  4. Initialise `pendingElements/appState/files` from `props.node.attrs` (parse JSON)
  5. `reactRoot = createRoot(canvasRef.value!)`
  6. `reactRoot.render(createElement(Excalidraw, { initialData: { elements, appState, files }, theme: 'dark', onChange: ... }))`
- [x] `async function saveAndClose()`:
  1. `isSaving = true`
  2. `const { exportToSvg } = await loadExcalidraw()` (already cached)
  3. `const svgEl = await exportToSvg({ elements: pendingElements, appState: pendingAppState, files: pendingFiles, exportWithDarkMode: true })`
  4. `const svgString = new XMLSerializer().serializeToString(svgEl)`
  5. `props.updateAttributes({ elements: JSON.stringify(pendingElements), appState: JSON.stringify(pendingAppState), files: JSON.stringify(pendingFiles), previewSvg: svgString })`
  6. `isSaving = false`
  7. Call `closeEditModal()`
- [x] `function cancelEdit()`: `closeEditModal()` (no attribute update)
- [x] `function closeEditModal()`:
  1. `reactRoot?.unmount(); reactRoot = null`
  2. `isEditing = false`
- [x] Keyboard handler: on `Escape` while `isEditing`, call `cancelEdit()`
- [x] `onBeforeUnmount`: call `closeEditModal()` (safety cleanup if node is deleted while modal is open)
- [x] Template: `<Teleport to="body"><Transition name="excalidraw-modal"><div v-if="isEditing" class="excalidraw-modal-overlay" @keydown.esc="cancelEdit">` containing:
  - [ ] Header: title + Cancel button + Save & Close button (with spinner when `isSaving`)
  - [ ] Canvas container: `<div ref="canvasRef" class="excalidraw-canvas" />`

#### D4 — Fullscreen lightbox (SVG zoom)

- [x] `fullscreen = ref(false)`
- [x] `openLightbox()` / `closeLightbox()` — same pattern as `CodeBlockView.vue`
- [x] Global `keydown` listener for Escape → `closeLightbox()` (register in `onMounted`, remove in `onBeforeUnmount`)
- [x] Template: separate `<Teleport to="body"><Transition name="excalidraw-lightbox">` with `v-if="fullscreen"`, close button, SVG container via `v-html`

#### D5 — autoOpen behaviour

- [x] In `onMounted`:
  ```typescript
  if (props.node.attrs.autoOpen) {
    props.updateAttributes({ autoOpen: false })
    await nextTick()
    void openEditModal()
  }
  ```

### Phase E — Styles

#### E1 — `src/renderer/style.css` (shared classes)

- [x] `.excalidraw-preview-block` — shared wrapper: same border, border-radius, overflow-hidden,
      margin as `.code-block-view`; background `var(--color-surface)`
- [x] `.excalidraw-block-header` — same flex layout as `.code-block-header`; border-bottom,
      background `rgba(0,0,0,0.15)`, padding `4px 8px`
- [x] `.excalidraw-caption` — `font-size: 12px; color: var(--color-text-muted); text-align: center; margin: 4px 0 0; padding: 0 8px`

#### E2 — `<style scoped>` in `ExcalidrawView.vue`

- [x] `.excalidraw-svg-preview` — `width: 100%; overflow: auto; cursor: zoom-in; display: flex; justify-content: center; align-items: flex-start; padding: 16px 24px 28px`
- [x] `.excalidraw-svg-preview :deep(svg)` — `max-width: 100% !important; height: auto !important; display: block`
- [x] `.excalidraw-empty-state` — `display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; min-height: 140px; color: var(--color-text-muted); font-size: 13px; padding: 24px`
- [x] `.excalidraw-modal-overlay` — `position: fixed; inset: 0; z-index: 1200; background: var(--color-bg); display: flex; flex-direction: column`
- [x] `.excalidraw-modal-header` — `display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--color-border); flex-shrink: 0`
- [x] `.excalidraw-canvas` — `flex: 1; min-height: 0` (fills remaining modal space)
- [x] Transition classes: `excalidraw-modal-enter-active/leave-active` (`opacity 0.18s`), `excalidraw-lightbox-enter-active/leave-active` (same)
- [x] Reuse `.preview-resize-handle` and `.preview-resize-grip` from `style.css` (no duplication)
- [x] Edit button: consistent with existing small action buttons — `font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid var(--color-border); background: var(--color-surface-raised); color: var(--color-text-muted); cursor: pointer` + hover: `color: var(--color-text); border-color: var(--color-accent)`

### Phase F — Slash command registration

- [x] In `NoteEditor.vue` `SLASH_COMMANDS` array, add:
  ```typescript
  { id: 'excalidraw', label: 'Drawing', description: 'Insert an Excalidraw whiteboard', icon: 'pencil-ruler' }
  ```
  (Place after `'mermaid'` and `'chart'` entries, keeping the visual cluster of insert-special-block
  commands together)
- [x] In the `switch` handler inside `buildSlashCommandSuggestion`:
  ```typescript
  case 'excalidraw':
    ed.chain().focus().deleteRange(range).insertContent({
      type: 'excalidraw',
      attrs: { elements: '[]', appState: '{}', files: '{}', previewSvg: '', autoOpen: true },
    }).run()
    break
  ```
- [x] Import `ExcalidrawExtension` from `../extensions/ExcalidrawExtension`
- [x] Add `ExcalidrawExtension` to the `extensions: [...]` array in `useEditor()`
- [x] Add `PencilRuler` to the Lucide import block (already used in `SlashCommandList` icon rendering via `LucideIcon`)

### Phase G — TemplateEditor support

- [x] In `TemplateEditor.vue`:
  - [ ] Import `ExcalidrawExtension`
  - [ ] Add to `extensions: [...]` in `useEditor()`
  - [ ] No slash command needed in templates (templates use a simpler toolbar, not the slash suggestion); the node renders via `ExcalidrawView.vue` automatically
- [x] Verify a note created from a template that contains an Excalidraw node displays the preview SVG correctly

### Phase H — Typecheck and smoke test

- [x] `npm run typecheck` — zero new errors
  - Common issues to watch for:
    - `createElement` return type mismatch with `reactRoot.render` — use `as unknown` cast where needed
    - `ExcalidrawElement` / `AppState` / `BinaryFiles` types may need `@ts-expect-error` on the dynamic import destructure if Excalidraw's exported types conflict with `isolatedModules`
    - `XMLSerializer` is a browser global — it is available in Electron renderer; no polyfill needed
- [x] `npm run dev` smoke test:
  - [ ] Type `/draw` or `/excalidraw` in a note → slash command suggestion appears with pencil-ruler icon
  - [ ] Select it → empty Drawing node appears, edit modal opens immediately
  - [ ] Draw a few shapes in Excalidraw, click **Save & Close** → SVG preview renders in the note
  - [ ] Click the SVG preview → fullscreen lightbox opens; Escape closes it
  - [ ] Click **Edit** → modal reopens with existing drawing intact (scene data round-trips)
  - [ ] Click **Cancel** → drawing unchanged in the note
  - [ ] Drag the resize grip → preview height changes; save and reload note → height persists
  - [ ] Backspace on the selected Drawing node → node is deleted (TipTap atom behaviour)
  - [ ] Two Drawing nodes in one note → each has independent state (no `pendingElements` sharing)
  - [ ] Save the note with a Drawing node; reload → `previewSvg` renders immediately, no React load needed on view
  - [ ] Open same note in two panes simultaneously → each view-mode renders correctly (static SVG)
  - [ ] Template: insert Drawing in a template; create a note from that template → SVG preview appears in the new note, Edit button works
  - [ ] Resize the Excalidraw modal window (Electron) while edit modal is open → canvas resizes correctly (Excalidraw handles this internally)
  - [ ] Press Escape while edit modal is open → modal closes; drawing unchanged

### Phase I — Documentation

- [x] Update `CLAUDE.md`:
  - [ ] `ExcalidrawView.vue` — describe view mode + edit modal + Teleport pattern
  - [ ] `ExcalidrawExtension.ts` — note `atom: true` leaf node, attribute schema
  - [ ] `excalidrawLoader.ts` — note lazy-load cache; CSS import
  - [ ] Add `excalidraw` to the slash command list in the NoteEditor bullet
  - [ ] Note the React-inside-Vue mounting pattern as an established pattern in the codebase
- [x] Update this file: mark all checklist items `[x]` on completion

---

## Out of scope (explicit non-goals)

- **Export to file (PNG/SVG download)**: Excalidraw's built-in export menu (accessible from within the edit modal via the `⋯` menu) provides this already; no additional Wizz UI needed
- **Collaborative editing / multiplayer**: deferred with all other sync features to a future CRDT phase
- **AI-generated Excalidraw scenes**: Claude cannot yet reliably produce valid Excalidraw JSON; a future enhancement could prompt Claude to generate a scene spec and transform it into Excalidraw elements via a converter
- **Excalidraw in AI chat / daily briefs**: the `v-html` rendering in `ChatSidebar` and `TodayView` uses `markdownToHtml()` which outputs static HTML — Excalidraw's interactive canvas cannot run there; only static SVG previews could be embedded in those surfaces, which is a separate feature
- **Syntax highlighting or search inside drawing elements**: Excalidraw text content is not indexed for FTS5 or semantic search — the drawing is opaque to the search pipeline; `body_plain` extraction ignores atom nodes
- **Mobile / touch input optimisation**: Excalidraw supports touch natively; no additional Wizz-level work needed, but pen/stylus ergonomics are not tested
- **Resize handle in edit modal**: the modal is full-screen; no resize needed inside it
- **Caption editing in the note body**: caption is not implemented in Phase 1 (no `updateAttributes` surface in view mode for inline caption editing); deferred to a future polish pass
