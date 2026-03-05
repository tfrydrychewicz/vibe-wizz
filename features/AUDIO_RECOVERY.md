# Audio Recording Resilience & Realtime-to-Batch Fallback — Design & Implementation Plan

## 1. Motivation

Wizz uses realtime WebSocket STT (ElevenLabs Scribe v2 Realtime, Deepgram Nova-3) to show live transcripts during meetings. These connections can fail mid-session — due to network drops, API quota, service outages, or an unexpected server close. When they do, the audio captured so far is lost and the user gets an error with no usable transcript.

Separately, the user explicitly asked for a way to **rerun transcription** after the fact (e.g. realtime gave a poor result, connection dropped early, or the session was interrupted). Today there is no way to do this without re-recording.

This feature adds two complementary capabilities:

1. **Persistent audio recording**: during any recording session, always write the audio stream to a local recovery file, in addition to forwarding it to the STT service.
2. **Automatic batch fallback**: when a realtime STT session fails unexpectedly, transparently retry using the saved audio against a batch STT endpoint instead of discarding the capture.

---

## 2. Design Principles

1. **Transparent to the user.** A realtime failure silently falls back to batch. The user sees a brief "Retrying with batch transcription…" status, not an error.
2. **Always-on, no setting required.** Recovery recording is not opt-in. It is the right default. (The existing `save_debug_audio` setting remains for debugging; this is separate.)
3. **No wasted storage.** Recovery files are deleted immediately after a successful transcription. Orphaned files from crashes are cleaned up on startup after retry.
4. **Consistent across backends.** All audio paths that provide PCM to the main process write the same WAV-based recovery file. The macOS Swift (offline) backend provides no audio to the main process and is explicitly excluded.
5. **Reuse existing abstractions.** The existing `buildWavBuffer()` function, `stopElevenLabsBatch()`, and `debugAudioChunks` patterns are the direct predecessors of this feature. The recovery recorder centralises what was previously ad-hoc.

---

## 3. Audio Path Coverage

| Backend | Audio source in main process | Format | Recovery possible |
|---------|------------------------------|--------|-------------------|
| ElevenLabs Realtime (mic) | IPC ArrayBuffer from renderer `ScriptProcessorNode` | PCM Int16 16kHz | ✅ WAV |
| ElevenLabs Batch (mic) | Same — already buffered in `batchAudioChunks[]` | PCM Int16 16kHz | ✅ WAV (same buffer) |
| Deepgram (mic, no system audio) | IPC ArrayBuffer from renderer `MediaRecorder` | WebM/Opus | ✅ WebM |
| Any backend + system audio (`AudioCapture.app`) | `onChunk` callback in `audioCapture.ts` | PCM Int16 16kHz | ✅ WAV |
| macOS SFSpeechRecognizer (`Transcriber.app`) | No audio chunks in main process | — | ❌ not applicable |

**Batch fallback endpoint**: ElevenLabs batch (`POST /v1/speech-to-text`) accepts both WAV and WebM/Opus (standard multipart upload). When an ElevenLabs key is configured, it is the universal retry target for all audio formats. If no ElevenLabs key is configured, batch retry is skipped and the partial transcript (whatever was accumulated before the failure) is saved instead.

---

## 4. Architecture

### 4.1 New Module: `src/main/transcription/recoveryRecorder.ts`

Encapsulates all recovery-recording logic. One instance per active session.

```typescript
// The format of audio being buffered
type RecoveryFormat = 'pcm' | 'webm'

interface RecoveryMeta {
  noteId: string
  startedAt: string          // ISO 8601
  format: RecoveryFormat
  filePath: string
}

class RecoveryRecorder {
  private chunks: Buffer[] = []
  private format: RecoveryFormat
  private filePath: string    // userData/transcription-recovery/<sessionId>.<wav|webm>
  private metaPath: string    // same stem, .json sidecar
  private flushed = false

  constructor(sessionId: string, format: RecoveryFormat, noteId: string, userDataPath: string)

  /** Add a chunk and flush to disk when accumulated size exceeds threshold (e.g. 2 MB) */
  push(chunk: Buffer): void

  /** Force-write all buffered chunks to disk now. Idempotent. */
  async flush(): Promise<string>  // returns filePath

  /** Return WAV Buffer from all chunks (PCM only; throws for WebM) */
  buildWav(): Buffer

  /** Delete recovery file + sidecar. Call on successful transcription. */
  async cleanup(): Promise<void>

  getFilePath(): string
  getMeta(): RecoveryMeta
}

// Exported helpers used by startup recovery scan
export function getRecoveryDir(userDataPath: string): string
export async function listOrphanedSessions(userDataPath: string): Promise<RecoveryMeta[]>
export async function deleteRecoverySession(meta: RecoveryMeta): Promise<void>
```

**Flush strategy**: chunks are appended to the file incrementally (not held in memory) once the in-memory buffer crosses 2 MB. A WAV header is written as a placeholder at file open and rewritten with the correct byte counts on close. WebM files are written as raw concatenated chunks.

**Recovery directory**: `{userData}/transcription-recovery/`. Each session produces two files:
- `session-{ulid}.wav` (or `.webm`) — the audio data
- `session-{ulid}.json` — sidecar metadata (`noteId`, `startedAt`, `format`, `filePath`)

### 4.2 Changes to `src/main/transcription/session.ts`

```
Session start:
  - For all non-Swift backends: instantiate RecoveryRecorder(sessionId, format, noteId, userData)
  - Store as module-level `activeRecovery: RecoveryRecorder | null`

Audio chunk received (IPC + AudioCapture.app onChunk):
  - BEFORE forwarding to WebSocket: activeRecovery?.push(buf)

Successful session end (stopSession → post-processing completes):
  - After processTranscript() resolves: activeRecovery?.cleanup()

handleUnexpectedClose(code):
  - NEW: after combining accumulated transcript, check activeRecovery
  - If activeRecovery exists AND elevenlabs_api_key is set:
    → call retryWithBatch(activeRecovery, partialTranscript)  [see §4.3]
  - Else:
    → existing behaviour (process with partial transcript, no batch retry)
  - activeRecovery is NOT cleaned up here; retryWithBatch cleans it on success
```

### 4.3 New Function: `retryWithBatch()`

Lives in `session.ts`, calls into the existing ElevenLabs batch infrastructure:

```typescript
async function retryWithBatch(
  recorder: RecoveryRecorder,
  partialTranscript: string,  // already-accumulated text before disconnect
): Promise<void>

Steps:
1. Push notification to renderer: transcription:status → "Retrying with batch transcription…"
   (new IPC push: transcription:retrying)
2. Flush recorder to disk (recorder.flush())
3. Read file into Buffer
4. If PCM: call stopElevenLabsBatch(chunks, apiKey, language)
           (reuse existing batch function — pass recorder.chunks directly,
            avoiding re-read from disk when still in memory)
   If WebM: POST directly to https://api.elevenlabs.io/v1/speech-to-text
            with file field set to WebM buffer, model_id=scribe_v2
5. Merge batch result with partialTranscript:
   - If batch result non-empty: use batch result (ignore partial — it was pre-disconnect)
   - If batch result empty/error: fall back to partialTranscript
6. Call processTranscript(noteId, mergedTranscript, ...)  as normal
7. On success: recorder.cleanup()
8. On error: keep recovery file; pushToRenderer('transcription:error', {...})
```

### 4.4 Startup Recovery Scan (`src/main/index.ts`)

On app startup, after `initDatabase()`:

```typescript
const orphans = await listOrphanedSessions(app.getPath('userData'))
if (orphans.length > 0) {
  log.info(`[Recovery] ${orphans.length} orphaned recording(s) found`)
  pushToRenderer('transcription:recovery-pending', { sessions: orphans.map(o => ({
    noteId: o.noteId,
    startedAt: o.startedAt,
    filePath: o.filePath,
  })) })
}
```

A new push event `transcription:recovery-pending` is sent to the renderer. The renderer shows a dismissible banner (see §4.5). If no Anthropic key is set (or no ElevenLabs key), orphaned files are simply deleted after 7 days via a TTL cleanup pass.

### 4.5 Renderer: Recovery Notification Banner

A new component `TranscriptionRecoveryBanner.vue` rendered at the top of `App.vue` (below the title bar, above the sidebar+content layout). It:

- Appears when `transcription:recovery-pending` push is received
- Shows: "N recording(s) from a previous session are pending transcription."
- Two buttons per session: **Process now** (triggers `transcription:retry-recovery` IPC) and **Discard**
- Dismisses automatically once all sessions are resolved
- Follows the same visual style as the existing error/info banners in the app

### 4.6 New IPC Channels

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `transcription:retrying` | push | `{ noteId, message: string }` | — |
| `transcription:recovery-pending` | push | `{ sessions: RecoveryMeta[] }` | — |
| `transcription:retry-recovery` | invoke | `{ filePath: string, noteId: string, format: 'pcm'\|'webm' }` | `{ ok }` |
| `transcription:discard-recovery` | invoke | `{ filePath: string }` | `{ ok }` |

`transcription:retry-recovery` reads the recovery file from disk and calls `retryWithBatch()` directly.

---

## 5. Interaction with Existing Debug Audio

The existing `save_debug_audio` / `debugAudioChunks` mechanism in `session.ts` remains unchanged. Recovery recording is:
- **Always on** (not toggled by any setting)
- **Cleaned up automatically** (not retained for inspection)
- **Structurally separate** from debug recordings

The two are independent. A user can have both active simultaneously without conflict.

---

## 6. Storage & Retention

| Scenario | File fate |
|----------|-----------|
| Realtime transcription succeeds | Deleted immediately after `processTranscript()` resolves |
| Realtime fails → batch retry succeeds | Deleted after batch `processTranscript()` resolves |
| Realtime fails → batch retry fails | Kept; `transcription:recovery-pending` sent on next startup |
| App crashes mid-session | Kept; offered for retry on next startup |
| Manual discard | Deleted immediately via `transcription:discard-recovery` |
| File older than 7 days (unclaimed) | Deleted by TTL cleanup pass on startup |

**Estimated file sizes** (16kHz Int16 PCM, 60-min meeting): ~115 MB WAV. Files are in the user's `userData` directory (local, private). They are excluded from any cloud sync (userData is not synced by default on macOS).

---

## 7. Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| ElevenLabs batch succeeds but returns empty transcript | Use partial accumulated transcript from realtime phase |
| No API key at all | Skip batch retry; process with partial transcript; keep recovery file for manual retry via startup recovery |
| Multiple simultaneous sessions | Each has its own `RecoveryRecorder` instance with a unique session ID (ULID) |
| Swift (offline) backend | `activeRecovery = null`; no-op on push and cleanup; no recovery file created |
| ElevenLabs batch mode (diarize=on) | Already buffers all chunks in `batchAudioChunks[]`; `RecoveryRecorder` reuses the same chunks (no double-copy); `batchAudioChunks` primary path unchanged |
| Very long recording (>1 hr) | Incremental flush to disk prevents OOM; in-memory buffer capped at 2 MB before flush |
| User starts transcription with no ElevenLabs key (Deepgram only) | Recovery file saved as WebM; retry attempted via ElevenLabs only if key becomes available; otherwise manual recovery deferred |
| Recovery file missing on retry-recovery IPC call | Return `{ ok: false, error: 'file not found' }`; renderer removes the session from the banner |

---

## 8. Implementation Checklist

### RecoveryRecorder module
- [] Create `src/main/transcription/recoveryRecorder.ts` with `RecoveryRecorder` class
  - [ ] Constructor: create `userData/transcription-recovery/` dir, set `filePath` + `metaPath`
  - [ ] `push(chunk)`: append to in-memory buffer; flush to disk when buffer > 2 MB
  - [ ] `flush()`: write WAV (PCM) or raw WebM to disk with correct header; write sidecar `.json`
  - [ ] `buildWav()`: delegate to existing `buildWavBuffer()` utility in `session.ts` (extract it to a shared util first)
  - [ ] `cleanup()`: `fs.rm(filePath)` + `fs.rm(metaPath)`, ignore ENOENT
  - [ ] Export `getRecoveryDir(userDataPath)`, `listOrphanedSessions()`, `deleteRecoverySession()`
- [ ] Extract `buildWavBuffer()` from `session.ts` into a new `src/main/transcription/wavUtils.ts` (reused by both `session.ts` and `recoveryRecorder.ts`)

### Session integration (`src/main/transcription/session.ts`)
- [ ] Add `activeRecovery: RecoveryRecorder | null = null` module-level variable
- [ ] In `startSession()`: create `RecoveryRecorder` for ElevenLabs and Deepgram paths; set `activeRecovery`
- [ ] In `startAudioCapture()` `onChunk` callback: call `activeRecovery?.push(buf)` before forwarding to WS
- [ ] In `ipcMain.on('transcription:audio-chunk')`: call `activeRecovery?.push(buf)` before routing to WS
- [ ] In `handleUnexpectedClose()`: call `retryWithBatch()` instead of directly calling `processTranscript()` when `activeRecovery` exists and ElevenLabs key is set
- [ ] Add `retryWithBatch(recorder, partialTranscript)` async function in `session.ts`
  - [ ] Push `transcription:retrying` to renderer
  - [ ] Flush recorder
  - [ ] Build WAV from recorder (PCM) or read raw WebM
  - [ ] POST to ElevenLabs batch endpoint (reuse `stopElevenLabsBatch()` logic or call it directly for PCM; raw POST for WebM)
  - [ ] Call `processTranscript()` with batch result (or partial if batch fails)
  - [ ] Call `activeRecovery?.cleanup()` on success
- [ ] In `stopSession()` cleanup path (post-processing success): call `activeRecovery?.cleanup()` after `processTranscript()` resolves
- [ ] In `cleanupSession()`: `activeRecovery = null` (do NOT cleanup file here — might be needed for retry)
- [ ] Add `transcription:retry-recovery` IPC handler: read file → call `retryWithBatch()` with a temporary `RecoveryRecorder` wrapper around the file bytes
- [ ] Add `transcription:discard-recovery` IPC handler: call `deleteRecoverySession(meta)` + return `{ ok }`

### Startup recovery (`src/main/index.ts`)
- [ ] Import `listOrphanedSessions`, `deleteRecoverySession` from `recoveryRecorder.ts`
- [ ] After `initDatabase()`: call `listOrphanedSessions()` and push `transcription:recovery-pending` if any found
- [ ] Add TTL cleanup: delete recovery files older than 7 days (check `meta.startedAt` vs `Date.now()`)

### New IPC push events (`src/main/push.ts` or inline)
- [ ] Register `transcription:retrying` push
- [ ] Register `transcription:recovery-pending` push
- [ ] Register `transcription:retry-recovery` invoke handler
- [ ] Register `transcription:discard-recovery` invoke handler
- [ ] Expose all 4 new channels in `src/preload/index.ts`

### Renderer: recovery banner (`src/renderer/`)
- [ ] Create `TranscriptionRecoveryBanner.vue`
  - [ ] Displays list of pending recovery sessions (date + linked note title if available)
  - [ ] "Process now" button → invokes `transcription:retry-recovery`
  - [ ] "Discard" button → invokes `transcription:discard-recovery`
  - [ ] Dismiss when all sessions resolved
  - [ ] Styled consistently with other app banners/alerts
- [ ] Mount `TranscriptionRecoveryBanner` in `App.vue` above the main layout
- [ ] In `App.vue`: listen to `transcription:recovery-pending` push, store sessions in a ref, pass to banner
- [ ] Listen to `transcription:retrying` push in `NoteEditor.vue` / transcription panel: show inline status "Retrying with batch transcription…" next to the recording indicator

### Status display in `NoteEditor.vue`
- [ ] Handle `transcription:retrying` push event: set a `transcriptionRetrying = true` state variable
- [ ] Show "Retrying transcription…" status in the Transcriptions panel while retrying
- [ ] Clear state on `transcription:complete` or `transcription:error`

### Verification
- [ ] `npm run typecheck` — no errors
- [ ] Start recording with ElevenLabs realtime; kill network mid-session; confirm auto-retry fires and transcript appears in note
- [ ] Start recording; stop normally; confirm recovery file is deleted from `userData/transcription-recovery/`
- [ ] Simulate a crash (kill process mid-session); relaunch; confirm recovery banner appears with the orphaned session
- [ ] Click "Process now" on the recovery banner; confirm transcript appears in the note
- [ ] Click "Discard"; confirm recovery file is deleted and banner dismisses
- [ ] Confirm Swift (macOS) backend produces no recovery file and no-ops silently
- [ ] Confirm debug audio (`save_debug_audio = true`) and recovery recording coexist without interference
