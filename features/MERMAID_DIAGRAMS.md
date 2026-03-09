# Mermaid Diagram Support in Code Blocks

## Overview

When a user selects **Mermaid** as the language of a code block, the block gains a live diagram preview rendered below the code. A **"hide code"** toggle in the block header lets the user collapse the raw Mermaid source and leave only the rendered diagram — perfect for embedding diagrams into meeting notes or decision records without visual clutter. The hidden/visible state is persisted in the TipTap document JSON so it survives saves and reloads.

No new editor primitive is introduced. This feature extends the existing `CodeBlockView.vue` node view and `CodeBlockLowlight` extension that were already shipped.

---

## Motivating Use Cases

| Scenario | Value |
|----------|-------|
| Architecture decision record | Embed a sequence or component diagram inline in the note alongside the prose; hide the Mermaid source so readers see only the diagram |
| 1:1 / project notes | Quickly sketch an org chart or state machine without leaving the note; keep code visible for iteration, hide it for presentation |
| Template diagrams | Store a reusable diagram skeleton in a note template; the diagram renders immediately when a new note is created from it |
| Meeting notes | Drop a quick flowchart summary of a decision made in the meeting; the code is there if you need to edit it later |

---

## Core Concepts

| Term | Meaning |
|------|---------|
| **Mermaid language** | The `mermaid` value for the code block's `language` attribute; triggers preview rendering and the hide/show toggle |
| **Diagram preview** | An SVG rendered by the `mermaid` library from the block's text content, displayed below the code `<pre>` |
| **Hide-code mode** | A persisted boolean node attribute (`hideCode`) that collapses the `<pre>` and the header border, leaving only the rendered diagram |
| **Error state** | When Mermaid fails to parse the source, the preview area shows the error message in a styled error box instead of crashing |
| **Mermaid initializer** | A singleton utility (`src/renderer/utils/mermaid.ts`) that configures and exposes the Mermaid instance app-wide |

---

## Architecture

### Where rendering lives

Mermaid rendering is **100% renderer-side** — it is a Vue component concern. No IPC, no main-process changes, no database changes are needed.

The feature touches exactly three files and adds one new utility:

| File | Change |
|------|--------|
| `src/renderer/utils/mermaid.ts` | **New** — singleton init + `renderMermaid(id, source)` helper |
| `src/renderer/components/CodeBlockView.vue` | Extended with mermaid preview pane + hide-code toggle |
| `src/renderer/components/NoteEditor.vue` | `CodeBlockLowlight` extension gains `hideCode` attribute via `.extend()` |
| `src/renderer/components/TemplateEditor.vue` | Same `.extend()` change as NoteEditor |

### The `hideCode` node attribute

The visibility state must survive auto-save round-trips (TipTap JSON → SQLite → reload). The correct place to store it is a **TipTap node attribute** on the code block node itself, alongside the existing `language` attribute.

```typescript
// Extended in NoteEditor.vue and TemplateEditor.vue
CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      hideCode: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-hide-code') === 'true',
        renderHTML: (attrs) => attrs.hideCode ? { 'data-hide-code': 'true' } : {},
      },
    }
  },
  addNodeView() {
    return VueNodeViewRenderer(CodeBlockView)
  },
}).configure({ lowlight })
```

The attribute is serialised into TipTap's JSON document body (stored in `notes.body`) and into the `pre` element's HTML when rendering to plain text — no schema migration needed.

### Mermaid singleton utility

```typescript
// src/renderer/utils/mermaid.ts
import mermaid from 'mermaid'

let initialised = false

export function ensureMermaidInit(): void {
  if (initialised) return
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    themeVariables: {
      background: '#242424',          // --color-surface
      mainBkg: '#242424',
      nodeBorder: '#2e2e2e',          // --color-border
      lineColor: '#888',              // --color-text-muted
      textColor: '#e8e8e8',           // --color-text
      edgeLabelBackground: '#242424',
      fontSize: '13px',
    },
    securityLevel: 'loose',           // allows SVG rendering inside Electron
  })
  initialised = true
}

// Returns { svg: string } on success or { error: string } on failure.
// Each call must use a unique `id` (used as SVG element id).
export async function renderMermaid(
  id: string,
  source: string
): Promise<{ svg: string } | { error: string }> {
  ensureMermaidInit()
  try {
    const { svg } = await mermaid.render(id, source)
    return { svg }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
```

`securityLevel: 'loose'` is required because Mermaid's default `'strict'` mode uses a sandboxed iframe that is blocked by Electron's CSP. `'loose'` renders into the main document directly, which is safe in a local-first desktop app with no untrusted content.

### CodeBlockView.vue — extended template structure

```
NodeViewWrapper.code-block-view
  ├─ div.code-block-header [contenteditable="false"]
  │   ├─ div.code-block-header-left               ← NEW when lang === 'mermaid'
  │   │   └─ button.code-block-hide-toggle        ← "Hide code" / "Show code"
  │   └─ select.code-block-lang-select            (existing)
  ├─ pre [v-show="!hideCode || lang !== 'mermaid'"]   ← conditionally hidden
  │   └─ NodeViewContent as="code"
  └─ div.mermaid-preview [v-if="lang === 'mermaid'"]  ← NEW
      ├─ div.mermaid-svg  [v-if="!mermaidError"]  ← v-html with SVG
      └─ div.mermaid-error [v-if="mermaidError"]  ← error message
```

The `<pre>` is hidden (not removed) with `v-show` so TipTap's `NodeViewContent` is always mounted and the document stays editable. Removing `NodeViewContent` from the DOM would break TipTap's ProseMirror integration.

### Re-render trigger

Mermaid re-renders whenever the code block's text content changes. The component watches `props.node.textContent` (debounced 400 ms) and the `selectedLanguage` computed. The debounce prevents re-renders on every keystroke.

```typescript
const debouncedRender = useDebounceFn(renderDiagram, 400)
watch(() => props.node.textContent, debouncedRender)
watch(selectedLanguage, (lang) => {
  if (lang === 'mermaid') debouncedRender()
})
```

`@vueuse/core` is already available in the project (used by other composables). If `useDebounceFn` is not available, a simple `setTimeout`/`clearTimeout` pattern is used instead.

### SVG id uniqueness

Mermaid's `render(id, source)` creates a DOM element with `id` equal to the given string. Using a static string would cause collisions when multiple mermaid blocks appear in one note. The id is generated once on component mount:

```typescript
const mermaidId = `mermaid-${Math.random().toString(36).slice(2)}`
```

---

## UI Behaviour

### Header in Mermaid mode

```
┌──────────────────────────────────────────────────────┐
│  [Hide code ↑]                          Mermaid ▾   │  ← header
├──────────────────────────────────────────────────────┤
│  graph TD                                            │  ← code (hideable)
│    A[Start] --> B{Decision}                          │
│    B -- Yes --> C[Do it]                             │
│    B -- No  --> D[Skip]                              │
├──────────────────────────────────────────────────────┤
│                                                      │
│          [rendered SVG diagram here]                 │  ← always visible
│                                                      │
└──────────────────────────────────────────────────────┘
```

When **"Hide code"** is clicked:
```
┌──────────────────────────────────────────────────────┐
│  [Show code ↓]                          Mermaid ▾   │  ← header (no bottom border)
│                                                      │
│          [rendered SVG diagram here]                 │
│                                                      │
└──────────────────────────────────────────────────────┘
```

The header bottom border is removed in hide-code mode so the diagram appears to float without visual gap.

### Error state

When the Mermaid source is invalid:
```
┌──────────────────────────────────────────────────────┐
│  [Hide code ↑]                          Mermaid ▾   │
├──────────────────────────────────────────────────────┤
│  graph TD                                            │
│    A --> B !!!syntax error                           │
├──────────────────────────────────────────────────────┤
│  ⚠  Mermaid syntax error                            │
│  Unexpected token '!!!' at line 2                   │
└──────────────────────────────────────────────────────┘
```

Error text is shown in `var(--color-danger)` inside a `var(--color-danger-subtle)` box. Hide-code mode is disabled when there is a render error (toggle button is greyed out with a tooltip "Fix syntax error first").

### Mermaid entry in the language dropdown

`mermaid` is added to the **top** of the named-language section in the `LANGUAGES` array (just after "Auto-detect") with the label `Mermaid (diagram)` so it is easy to find:

```typescript
{ value: 'mermaid', label: 'Mermaid (diagram)' },
```

Lowlight has no `mermaid` grammar, so when `language === 'mermaid'` no syntax highlighting tokens are applied (the source is monochrome). This is intentional: the diagram preview is the primary rendering surface; highlighting the Mermaid DSL is not worth the complexity.

---

## Dependencies

| Package | Version strategy | Rationale |
|---------|-----------------|-----------|
| `mermaid` | `npm install mermaid` (latest stable) | Official library; renders entirely in the browser/Electron renderer; no server component |

No other new dependencies. `@vueuse/core` is already in the project; `useDebounceFn` will be used if available, with a plain `setTimeout` fallback.

---

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Where to store hide-code state | TipTap node attribute | Survives save/reload; no separate DB column or localStorage key needed |
| When to re-render | Debounced watch on `node.textContent` | Avoids per-keystroke re-renders while keeping diagram fresh |
| Mermaid security level | `'loose'` | Electron CSP blocks iframe sandbox; trusted local content only |
| SVG injection method | `v-html` on a scoped `div` | Simplest approach; SVG from `mermaid.render()` is safe (generated locally) |
| Error handling | Inline error box inside preview pane | Never throws to Vue; shows actionable message without breaking the editor |
| Hide-code with error | Disabled | Prevents user from hiding a broken diagram and losing track of the error |
| `NodeViewContent` visibility | `v-show` (not `v-if`) | TipTap requires `NodeViewContent` to remain mounted for ProseMirror to track cursor/selection inside the code block |
| Code block language parity | `mermaid` added to `LANGUAGES` list in `CodeBlockView.vue` | Single source of truth; shared by both NoteEditor and TemplateEditor |

---

## Implementation Checklist

### Phase A — Install Mermaid

- [ ] `npm install mermaid`
- [ ] Verify `mermaid` appears in `package.json` `dependencies`

### Phase B — Mermaid Initializer Utility

- [ ] Create `src/renderer/utils/mermaid.ts`
  - [ ] `ensureMermaidInit()` — idempotent singleton; dark theme with Wizz design tokens; `securityLevel: 'loose'`
  - [ ] `renderMermaid(id: string, source: string): Promise<{ svg: string } | { error: string }>` — wraps `mermaid.render()` in try/catch
- [ ] Confirm Electron CSP allows inline SVG (`unsafe-inline` already present or add `style-src` exception if needed)

### Phase C — `hideCode` Node Attribute

- [ ] In `NoteEditor.vue`: extend `CodeBlockLowlight` with `hideCode` attribute (default `false`, `parseHTML` reads `data-hide-code`, `renderHTML` writes it only when `true`)
- [ ] In `TemplateEditor.vue`: same extension (both files share `CodeBlockView` but each must declare the attribute so TipTap's schema includes it)
- [ ] Verify the attribute round-trips through `notes:update` → `notes:get` without loss (check JSON body includes `hideCode` on the code block node)

### Phase D — Mermaid Language Entry

- [ ] Add `{ value: 'mermaid', label: 'Mermaid (diagram)' }` as the second entry in `LANGUAGES` array in `CodeBlockView.vue` (immediately after "Auto-detect")

### Phase E — CodeBlockView.vue: Preview Pane + Toggle

- [ ] Add `mermaidId` ref — generated once on `setup` with `Math.random().toString(36).slice(2)`, prefixed `mermaid-`
- [ ] Add `mermaidSvg: Ref<string>` and `mermaidError: Ref<string>` refs
- [ ] Add `renderDiagram()` async function
  - [ ] Guard: skip if `selectedLanguage !== 'mermaid'` or `props.node.textContent.trim() === ''`
  - [ ] Call `renderMermaid(mermaidId, props.node.textContent)`
  - [ ] On success: set `mermaidSvg`, clear `mermaidError`
  - [ ] On error: clear `mermaidSvg`, set `mermaidError`
- [ ] Debounce `renderDiagram` 400 ms (use `useDebounceFn` from `@vueuse/core` or plain `setTimeout`/`clearTimeout`)
- [ ] `watch(() => props.node.textContent, debouncedRender)`
- [ ] `watch(selectedLanguage, (lang) => { if (lang === 'mermaid') debouncedRender() })`
- [ ] Call `renderDiagram()` in `onMounted` (covers note open when language is already `mermaid`)
- [ ] Add `hideCode` computed from `props.node.attrs.hideCode`
- [ ] Add `toggleHideCode()` — calls `props.updateAttributes({ hideCode: !props.node.attrs.hideCode })`
- [ ] Template changes:
  - [ ] Wrap header contents: left slot (hide toggle, `v-if="selectedLanguage === 'mermaid'"`) + right slot (lang select)
  - [ ] Hide toggle button: `"Hide code"` / `"Show code"` label + chevron icon; disabled + tooltip when `mermaidError`
  - [ ] Apply `v-show="selectedLanguage !== 'mermaid' || !hideCode"` on `<pre>`
  - [ ] Remove header `border-bottom` class when `hideCode && !mermaidError` (`code-block-header--seamless` modifier class)
  - [ ] Mermaid preview `<div class="mermaid-preview" v-if="selectedLanguage === 'mermaid'">`
    - [ ] SVG container: `<div class="mermaid-svg" v-if="mermaidSvg" v-html="mermaidSvg" />`
    - [ ] Error container: `<div class="mermaid-error" v-if="mermaidError">⚠ {{ mermaidError }}</div>`
    - [ ] Loading state: `<div class="mermaid-loading" v-if="!mermaidSvg && !mermaidError">Rendering…</div>`
- [ ] Import `renderMermaid` from `../utils/mermaid`
- [ ] Import `onMounted`, `watch` from `vue`

### Phase F — Styles

- [ ] In `CodeBlockView.vue` `<style scoped>`:
  - [ ] `.code-block-header` becomes `display: flex; justify-content: space-between` (left and right zones)
  - [ ] `.code-block-header--seamless` — removes `border-bottom`
  - [ ] `.code-block-hide-toggle` — small text button, `color: var(--color-text-muted)`, hover `var(--color-text)`, `font-size: 11px`, `background: none`, `border: none`, `cursor: pointer`, `display: flex; align-items: center; gap: 4px`
  - [ ] `.code-block-hide-toggle:disabled` — `opacity: 0.4; cursor: not-allowed`
  - [ ] `.mermaid-preview` — `padding: 16px; display: flex; justify-content: center; align-items: flex-start; min-height: 80px`
  - [ ] `.mermaid-svg` — `max-width: 100%; overflow-x: auto`
  - [ ] `.mermaid-svg :deep(svg)` — `max-width: 100%; height: auto; display: block`
  - [ ] `.mermaid-error` — `padding: 10px 14px; border-radius: 6px; background: var(--color-danger-subtle); border: 1px solid var(--color-danger-border); color: var(--color-danger); font-size: 12px; white-space: pre-wrap; font-family: 'SF Mono', monospace`
  - [ ] `.mermaid-loading` — `color: var(--color-text-muted); font-size: 12px; font-style: italic`

### Phase G — Typecheck + Smoke Test

- [ ] `npm run typecheck` — zero new errors introduced
- [ ] Dev build (`npm run dev`) smoke test:
  - [ ] Insert code block, select "Mermaid (diagram)" from dropdown
  - [ ] Type `graph TD\n  A --> B` — diagram appears below code within ~400 ms
  - [ ] Type invalid syntax — error box replaces diagram; hide toggle is disabled
  - [ ] Fix syntax — diagram returns; hide toggle re-enables
  - [ ] Click "Hide code" — `<pre>` collapses, header loses bottom border, diagram remains
  - [ ] Click "Show code" — `<pre>` returns
  - [ ] Save note and reload — `hideCode` state and `language` are preserved
  - [ ] Open same note in TemplateEditor path — same behaviour
  - [ ] Multiple mermaid blocks in one note — each renders independently (unique `mermaidId`)

### Phase H — Documentation

- [ ] Update `CLAUDE.md`:
  - [ ] Add `CodeBlockView.vue` bullet: mermaid preview pane, `hideCode` attribute, `renderMermaid()` utility
  - [ ] Add `src/renderer/utils/mermaid.ts` to the utilities section
  - [ ] Note `hideCode` as a known TipTap node attribute on code blocks
- [ ] Update `DESIGN.md` Phase 5 (Polish): add `[x] Mermaid diagram support in code blocks` item
- [ ] Update this file: mark all checklist items complete

---

## Out of Scope (Explicit Non-Goals)

- **Mermaid syntax highlighting in the code editor**: lowlight has no Mermaid grammar; adding one is not worth the bundle size cost — the diagram preview is the primary surface
- **Export to PNG/SVG**: the SVG is already in the DOM; copy-as-image can be a future enhancement
- **Mermaid in AI-rendered chat messages** (`v-html` in `ChatSidebar`): AI does not currently generate Mermaid — out of scope for this phase
- **Mermaid in `markdownToHtml` utility**: the markdown renderer in `TodayView`/`EntityReviewPanel` does not need Mermaid; fenced code blocks there are rendered as plain `<pre>` — adding live rendering in those contexts is a separate feature
- **Real-time collaboration / CRDT sync of `hideCode`**: deferred with all other sync concerns to a future phase
