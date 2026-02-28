# Image Attachments in NoteEditor — Design & Implementation Plan

## 1. Motivation

Engineering managers accumulate screenshots, diagrams, architecture drawings, and other visual
artifacts during their day. DESIGN.md already lists "Drag-and-drop image embedding (stored locally
in app data)" as a core feature, and `@tiptap/extension-image` is even present in `package.json`,
but the capability was never wired up. This feature activates it — letting users paste or drag images
directly into notes and templates so visuals live alongside the written context, persisted across sessions.

---

## 2. Design Principles

1. **Inline, not attached.** Images become first-class nodes inside the TipTap document, not a
   separate attachment bar. They flow with the prose, can be placed anywhere, and are saved as part
   of the note body.

2. **Local-first, zero configuration.** Images are base64-encoded and stored inline in the TipTap
   JSON body (the `notes.body` column in SQLite). No server, no separate file table, no API key,
   no new migration. The single-file SQLite approach of Wizz is preserved.

3. **Reuse existing validation.** `useFileAttachment.ts` already defines `ALLOWED_IMAGE_TYPES`
   (`image/jpeg`, `image/png`, `image/gif`, `image/webp`) and `MAX_FILE_SIZE` (10 MB). These
   constants are imported and reused — no duplicate logic.

4. **Consistent across surfaces.** The Image extension is registered in both `NoteEditor.vue`
   (full editing + drop/paste) and `TemplateEditor.vue` (display-only — images that appear in a
   template body render correctly, even if authoring templates with images is not a primary flow).

5. **FTS5 and embedding pipeline are unaffected.** The `body_plain` column (used for FTS5 and
   the chunker) is extracted by TipTap's text serialiser, which ignores image nodes. No guard
   code is needed.

---

## 3. Architecture

### 3.1 Storage: Base64 inline in `notes.body`

```
Drop / Paste (browser FileList)
        │
        ▼
FileReader.readAsDataURL(file)        ← renderer-side, no IPC
        │
        ▼
"data:image/jpeg;base64,/9j/4AA..."
        │
        ▼
editor.commands.setImage({ src: dataUrl })
        │
        ▼
TipTap document JSON:
{
  "type": "image",
  "attrs": {
    "src": "data:image/jpeg;base64,/9j/4AA...",
    "alt": null,
    "title": null
  }
}
        │
        ▼
notes:update (existing IPC) → SQLite notes.body
```

No new IPC handler, no new DB table, no migration.

### 3.2 Packages

| Package | Status | Purpose |
|---------|--------|---------|
| `@tiptap/extension-image` | Already installed | Renders `<image>` nodes in ProseMirror |
| `@tiptap/extension-file-handler` | **New** | Intercepts drop / paste FileList events |

### 3.3 Validation (reused from `useFileAttachment.ts`)

```typescript
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_FILE_SIZE = 10 * 1024 * 1024   // 10 MB

function isAllowedImage(file: File): boolean {
  return ALLOWED_IMAGE_TYPES.includes(file.type) && file.size <= MAX_FILE_SIZE
}
```

Files that fail validation are silently ignored (no crash, no error toast — consistent with
the AI modal's behaviour).

---

## 4. Component Changes

### NoteEditor.vue

- Add `FileHandler` to the TipTap extensions array:
  ```typescript
  FileHandler.configure({
    allowedMimeTypes: ALLOWED_IMAGE_TYPES,
    onPaste(editor, files) {
      files.filter(isAllowedImage).forEach(file => insertImage(editor, file))
    },
    onDrop(editor, files, pos) {
      files.filter(isAllowedImage).forEach(file => insertImage(editor, file, pos))
    },
  })
  ```
- Add `TiptapImage.configure({ allowBase64: true, HTMLAttributes: { class: 'editor-image' } })`.
- `insertImage(editor, file, pos?)` reads the file as a data URL via `FileReader` and calls
  `editor.commands.setImage({ src })` (with `.focus().insertContentAt(pos, ...)` when `pos` is given).

### TemplateEditor.vue

- Add `TiptapImage.configure({ allowBase64: true, HTMLAttributes: { class: 'editor-image' } })`.
- **No FileHandler** — template authoring does not need drop/paste image support.

### Shared CSS (`.editor-image`)

```css
.editor-image {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
  display: block;
  margin: 8px 0;
  cursor: default;
}
```

Applied in the `<style>` blocks of both `NoteEditor.vue` and `TemplateEditor.vue`.

---

## 5. Out of Scope

- **Image resize handles** — requires `@tiptap/extension-image` Pro features; leave for a later phase.
- **Separate `note_files` DB table** — base64 inline is sufficient for now; revisit if large images
  become a performance concern.
- **Non-image file embedding** (PDFs, CSVs inline in editor) — separate future feature.
- **FileHandler in TemplateEditor** — low priority; template bodies don't need image authoring today.

---

## 6. Implementation Checklist

- [x] Create this design document (`features/IMAGE_ATTACHMENTS.md`)
- [ ] `npm install @tiptap/extension-file-handler`
- [ ] **NoteEditor.vue**: import `FileHandler`; import `ALLOWED_IMAGE_TYPES`/`MAX_FILE_SIZE` from `useFileAttachment`; add `TiptapImage` + `FileHandler` to extensions array; implement `insertImage()` helper
- [ ] **NoteEditor.vue**: add `.editor-image` CSS
- [ ] **TemplateEditor.vue**: import `TiptapImage`; add to extensions array; add `.editor-image` CSS
- [ ] `npm run typecheck` — zero new errors
- [ ] Manual test: drag image into note → persists on reopen
- [ ] Manual test: paste image from clipboard → persists on reopen
- [ ] Manual test: oversized / non-image file → silently ignored
- [ ] Manual test: FTS search for note content still works correctly
