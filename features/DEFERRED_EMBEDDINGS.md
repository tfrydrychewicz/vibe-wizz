# Deferred Embedding Regeneration — Design & Implementation Plan

## 1. Motivation

L1 chunk embeddings and L2 note-summary embeddings are regenerated on every auto-save (500ms debounce while typing). For an active editing session this means dozens of expensive API round-trips — an OpenAI embedding call and a Claude Haiku summarisation call — all producing intermediate results that will be immediately overwritten on the next keystroke.

NER entity detection **is** worth running on every save because it drives the live entity-decoration hints in the editor and is comparatively fast.

This feature defers L1+L2 embedding work to the earliest natural pause: when the user leaves the note (focus loss), with automatic recovery at app startup for any notes that were dirty when the app crashed or was force-quit.

---

## 2. Design Principles

1. **NER stays immediate.** Entity detection decorations in the editor must be current — NER continues to run on every save.
2. **Embeddings follow focus.** L1 chunks + L2 summary run once, when editing is done, not on every keystroke.
3. **No embedding work is ever lost.** An `embedding_dirty` flag in the DB acts as a durable queue entry. Crash recovery on startup processes any leftover dirty notes.
4. **Consistent trigger surface.** Any path that navigates the user away from a note (note switch, pane close, view switch, app quit) must fire the embedding trigger.
5. **Transparency via `postProcessor.ts`.** Transcript post-processing bypasses the deferral — it updates the note in bulk, and embeddings should reflect that immediately.

---

## 3. Architecture Changes

### 3.1 New `embedding_dirty` Column on `notes`

```sql
ALTER TABLE notes ADD COLUMN embedding_dirty INTEGER NOT NULL DEFAULT 0;
```

| Value | Meaning |
|-------|---------|
| `0` | L1+L2 embeddings are current |
| `1` | Note content changed since last embedding run |

- Set to `1` by the `notes:update` IPC handler on every save
- Cleared to `0` by `runEmbeddingPipeline()` on successful completion

### 3.2 Pipeline Refactor (`src/main/embedding/pipeline.ts`)

Current `runPipeline()` runs NER and L1+L2 concurrently in one `Promise.all`. Split into three functions:

```
runNerPipeline(noteId)       — NER only (Anthropic-only, fast)
runEmbeddingPipeline(noteId) — L1+L2 only (OpenAI + sqlite-vec; clears dirty flag on success)
runPipeline(noteId)          — NER + L1+L2 concurrently (kept for postProcessor.ts)
```

New exports:
- `scheduleNer(id)` → fire-and-forget `runNerPipeline()` (called from `notes:update`)
- `scheduleEmbeddingOnly(id)` → fire-and-forget `runEmbeddingPipeline()` (called from `notes:trigger-embedding` and startup)
- `scheduleEmbedding(id)` → unchanged, still calls `runPipeline()` (used by `postProcessor.ts`)
- `processDirtyNotes()` → sequentially re-embeds all dirty notes (called on startup)

### 3.3 New IPC: `notes:trigger-embedding`

```
Invoke: { id: string } → { ok: true }
```

Called from the renderer whenever a note loses focus. Checks the `embedding_dirty` flag and, if set, calls `scheduleEmbeddingOnly(id)`. No-op if the note is clean.

### 3.4 Renderer Trigger Points (`src/renderer/components/NoteEditor.vue`)

| Event | Action |
|-------|--------|
| Note switch (same pane, `props.noteId` watch, `oldId`) | Invoke `notes:trigger-embedding` with old note ID after flushing pending save |
| Component unmount (`onBeforeUnmount`) | Invoke `notes:trigger-embedding` with current note ID |

`onBeforeUnmount` covers: pane close, switching to Calendar / Today / Search / Trash (v-if unmounts NoteEditor), and normal app quit (renderer unmounts all components).

### 3.5 Startup Recovery (`src/main/index.ts`)

```typescript
processDirtyNotes().catch(console.error)
```

Runs after `initDatabase()`. Queries notes with `embedding_dirty = 1`, processes them sequentially (to avoid flooding the API), up to 50 at a time (most recently modified first).

---

## 4. What Does NOT Change

- **NER** runs on every save via `scheduleNer()` — same frequency as before
- **`postProcessor.ts`** calls `scheduleEmbedding()` → full pipeline (NER + L1+L2) immediately after transcript processing
- **Action item extraction** — on-demand only, no change
- **L3 cluster batch** — nightly, no change
- **Preload** — generic bridge, no whitelist changes needed

---

## 5. Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| User edits note, never navigates away | `embedding_dirty = 1` persists; caught on next startup |
| App crash mid-edit | Dirty flag persists in DB; caught on next startup |
| Rapid note switching | `trigger-embedding` fires for each left note; pipelines run concurrently per noteId (idempotent) |
| No API keys configured | `runEmbeddingPipeline()` returns early; dirty flag stays `1`; retried on next focus-loss |
| Multiple panes showing same note | Both fire `trigger-embedding` on unmount; second call is a no-op (flag already `0`) |
| Transcript post-processed | `scheduleEmbedding()` runs full pipeline immediately; clears dirty flag |

---

## 6. Implementation Checklist

### DB & Migration
- [ ] Add `embedding_dirty INTEGER NOT NULL DEFAULT 0` to `notes` CREATE TABLE in `src/main/db/schema.ts` (fresh installs)
- [ ] Create `src/main/db/migrations/0006_notes_embedding_dirty.ts` with `ALTER TABLE notes ADD COLUMN embedding_dirty INTEGER NOT NULL DEFAULT 0`
- [ ] Register migration 0006 in `ALL_MIGRATIONS` in `src/main/db/migrations/index.ts`

### Embedding Pipeline (`src/main/embedding/pipeline.ts`)
- [ ] Extract NER logic from `runPipeline()` into `runNerPipeline(noteId)`
- [ ] Extract L1+L2 logic from `runPipeline()` into `runEmbeddingPipeline(noteId)`; on success run `UPDATE notes SET embedding_dirty = 0`
- [ ] Rewrite `runPipeline()` as `Promise.all([runNerPipeline(id), runEmbeddingPipeline(id)])`
- [ ] Export `scheduleNer(id)` — fire-and-forget `runNerPipeline()`
- [ ] Export `scheduleEmbeddingOnly(id)` — fire-and-forget `runEmbeddingPipeline()`
- [ ] Export `processDirtyNotes()` — sequential startup recovery (SELECT dirty, loop with await, LIMIT 50)

### IPC (`src/main/db/ipc.ts`)
- [ ] In `notes:update` handler: remove `scheduleEmbedding(id)`, add `scheduleNer(id)` + `UPDATE notes SET embedding_dirty = 1 WHERE id = ?`
- [ ] Add `notes:trigger-embedding` handler: check `embedding_dirty`, call `scheduleEmbeddingOnly(id)` if dirty

### App Startup (`src/main/index.ts`)
- [ ] Import `processDirtyNotes` from `pipeline.ts`
- [ ] Call `processDirtyNotes().catch(console.error)` immediately after `initDatabase()`

### Renderer (`src/renderer/components/NoteEditor.vue`)
- [ ] In `watch` on `props.noteId`: after flushing save for `oldId`, invoke `notes:trigger-embedding` with `oldId`
- [ ] In `onBeforeUnmount`: invoke `notes:trigger-embedding` with `props.noteId` before `editor.value?.destroy()`

### Verification
- [ ] `npm run typecheck` — no errors
- [ ] `npm run dev` — type in a note; confirm NER logs appear but NO L1/L2 embedding logs during typing
- [ ] Navigate to Calendar — confirm L1/L2 embedding logs fire once for the left note
- [ ] Force-quit mid-edit; reopen — confirm startup log: `[Embedding] N dirty note(s) queued for startup re-embedding`
- [ ] Query DB: `SELECT id, embedding_dirty FROM notes LIMIT 5` to confirm flag is cleared after embedding
