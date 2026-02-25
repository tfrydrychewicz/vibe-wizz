/**
 * Transcription session manager.
 *
 * Manages a single active transcription session with three backends:
 *
 *   1. ElevenLabs Scribe v2 Realtime (cloud) — used when `elevenlabs_api_key` is configured.
 *      Audio captured as PCM 16kHz Int16 by the renderer (ScriptProcessorNode) and streamed
 *      to main via `transcription:audio-chunk`. Chunks are base64-encoded and sent as JSON.
 *
 *   2. Deepgram Nova-3 (cloud) — used when `deepgram_api_key` is configured and no ElevenLabs key.
 *      Renderer captures mic with getUserMedia/MediaRecorder (WebM/Opus) and streams raw binary
 *      chunks to main via `transcription:audio-chunk`.
 *
 *   3. SFSpeechRecognizer (offline fallback) — used when no cloud key is set.
 *      The Swift Transcriber binary captures the mic directly; no audio chunks from the
 *      renderer are needed.
 *
 * All backends emit the same IPC events to the renderer:
 *   transcription:partial  — { text, isFinal }
 *   transcription:complete — { noteId }
 *   transcription:error    — { message }
 *
 * IPC channels registered here:
 *   transcription:start       (invoke) — { noteId, eventId } → { ok, audioFormat?, error? }
 *   transcription:stop        (invoke) — → { ok }
 *   transcription:audio-chunk (send)   — ArrayBuffer (cloud paths only)
 *   transcription:status      (invoke) — → { isTranscribing, noteId }
 *   transcription:process     (invoke) — { noteId, transcript } → { ok }
 */

import { ipcMain } from 'electron'
import WebSocket from 'ws'
import { getDatabase } from '../db/index'
import { pushToRenderer } from '../push'
import { processTranscript } from './postProcessor'
import {
  startSwiftTranscriber,
  stopSwiftTranscriber,
  isSwiftTranscriberActive,
} from './swiftTranscriber'

// ── Session state ──────────────────────────────────────────────────────────────

let isTranscribing = false
let sessionNoteId: string | null = null
let sessionEventId: number | null = null
let sessionStartedAt: string | null = null
let ws: WebSocket | null = null
let accumulatedTranscript = ''
// Most recent non-final transcript (shown while streaming, not included in accumulated)
let partialBuffer = ''
// Which cloud backend is currently active
let activeBackend: 'deepgram' | 'elevenlabs' = 'deepgram'

// ── Deepgram connection ────────────────────────────────────────────────────────

const DEEPGRAM_BASE_URL = 'wss://api.deepgram.com/v1/listen'

interface DeepgramResult {
  type: string
  is_final: boolean
  channel: {
    alternatives: Array<{ transcript: string }>
  }
}

function openDeepgramSocket(apiKey: string, language: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Note: do NOT pass encoding= for container formats (WebM/Opus from MediaRecorder).
    // Deepgram auto-detects the format from the bitstream when encoding is omitted.
    // Specifying encoding=webm causes a 400 because webm is a container, not a codec.
    const params = new URLSearchParams({
      model: 'nova-3',
      language,
      punctuate: 'true',
      smart_format: 'true',
      diarize: 'true',
    })
    const url = `${DEEPGRAM_BASE_URL}?${params.toString()}`
    console.log('[Transcription] Connecting to Deepgram:', url.replace(/Token [^&]+/, 'Token ***'))

    ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    })

    ws.on('open', () => {
      console.log('[Transcription] Deepgram WebSocket connected (language:', language, ')')
      resolve()
    })

    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => {
        const msg = `Deepgram rejected connection (HTTP ${res.statusCode}): ${body}`
        console.error('[Transcription]', msg)
        reject(new Error(msg))
      })
    })

    ws.on('error', (err) => {
      console.error('[Transcription] Deepgram WS error:', err.message)
      if (!isTranscribing) {
        reject(err)
      } else {
        pushToRenderer('transcription:error', { message: err.message })
        cleanupSession()
      }
    })

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as DeepgramResult
        if (msg.type !== 'Results') return
        const text = msg.channel?.alternatives?.[0]?.transcript ?? ''
        if (!text) return
        if (msg.is_final) {
          accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + text
          partialBuffer = ''
          pushToRenderer('transcription:partial', { text, isFinal: true })
        } else {
          partialBuffer = text
          pushToRenderer('transcription:partial', { text, isFinal: false })
        }
      } catch {
        // Ignore parse errors from Deepgram metadata messages
      }
    })

    ws.on('close', () => {
      console.log('[Transcription] Deepgram WebSocket closed')
    })
  })
}

// ── ElevenLabs connection ──────────────────────────────────────────────────────

// Correct endpoint: /realtime (not /stream)
const ELEVENLABS_STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'

interface ElevenLabsMessage {
  message_type: string
  text?: string
}

function openElevenLabsSocket(apiKey: string, language: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ model_id: 'scribe_v2_realtime' })
    // For 'multi' (auto-detect), omit the language param — ElevenLabs auto-detects from audio
    if (language !== 'multi') params.set('language_code', language)
    const url = `${ELEVENLABS_STT_URL}?${params.toString()}`
    console.log('[Transcription] Connecting to ElevenLabs:', url)

    ws = new WebSocket(url, {
      headers: { 'xi-api-key': apiKey },
    })

    ws.on('open', () => {
      console.log('[Transcription] ElevenLabs WebSocket connected (language:', language, ')')
      resolve()
    })

    ws.on('unexpected-response', (_req, res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => { body += chunk.toString() })
      res.on('end', () => {
        const msg = `ElevenLabs rejected connection (HTTP ${res.statusCode}): ${body}`
        console.error('[Transcription]', msg)
        reject(new Error(msg))
      })
    })

    ws.on('error', (err) => {
      console.error('[Transcription] ElevenLabs WS error:', err.message)
      if (!isTranscribing) {
        reject(err)
      } else {
        pushToRenderer('transcription:error', { message: err.message })
        cleanupSession()
      }
    })

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString()) as ElevenLabsMessage
        if (msg.message_type === 'partial_transcript' && msg.text) {
          partialBuffer = msg.text
          pushToRenderer('transcription:partial', { text: msg.text, isFinal: false })
        } else if (msg.message_type === 'committed_transcript' && msg.text) {
          accumulatedTranscript += (accumulatedTranscript ? ' ' : '') + msg.text
          partialBuffer = ''
          pushToRenderer('transcription:partial', { text: msg.text, isFinal: true })
        }
      } catch {
        // Ignore parse errors from ElevenLabs metadata messages
      }
    })

    ws.on('close', () => {
      console.log('[Transcription] ElevenLabs WebSocket closed')
    })
  })
}

// ── Session lifecycle ──────────────────────────────────────────────────────────

function cleanupSession(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.close() } catch { /* ignore */ }
  }
  ws = null
  isTranscribing = false
  sessionNoteId = null
  sessionEventId = null
  sessionStartedAt = null
  accumulatedTranscript = ''
  partialBuffer = ''
  activeBackend = 'deepgram'
}

async function startSession(
  noteId: string,
  eventId: number,
  apiKey: string,
  language: string,
  backend: 'deepgram' | 'elevenlabs',
): Promise<void> {
  if (isTranscribing) {
    console.warn('[Transcription] Session already active, ignoring start')
    return
  }
  sessionNoteId = noteId
  sessionEventId = eventId
  sessionStartedAt = new Date().toISOString()
  accumulatedTranscript = ''
  partialBuffer = ''
  activeBackend = backend
  if (backend === 'elevenlabs') {
    await openElevenLabsSocket(apiKey, language)
    console.log('[Transcription] ElevenLabs session started for note', noteId)
  } else {
    await openDeepgramSocket(apiKey, language)
    console.log('[Transcription] Deepgram session started for note', noteId)
  }
  isTranscribing = true
}

async function stopSession(): Promise<void> {
  if (!isTranscribing || !ws) return
  const noteId = sessionNoteId!
  const startedAt = sessionStartedAt
  const finalTranscript = accumulatedTranscript + (partialBuffer ? ' ' + partialBuffer : '')

  // ElevenLabs: send a final audio chunk with commit:true to flush the last segment,
  // then wait briefly for the committed_transcript to arrive before closing.
  if (activeBackend === 'elevenlabs' && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }))
      await new Promise<void>(resolve => setTimeout(resolve, 500))
    } catch { /* ignore */ }
  }

  const endedAt = new Date().toISOString()

  if (ws.readyState === WebSocket.OPEN) {
    ws.close()
  }
  ws = null
  isTranscribing = false
  sessionNoteId = null
  sessionEventId = null
  sessionStartedAt = null
  accumulatedTranscript = ''
  partialBuffer = ''
  activeBackend = 'deepgram'

  // Post-processing runs fire-and-forget
  const db = getDatabase()
  const anthRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic_api_key') as { value: string } | undefined
  processTranscript(noteId, finalTranscript, anthRow?.value ?? '', startedAt ?? undefined, endedAt).catch((err) => {
    console.error('[Transcription] Post-processing error:', err)
    pushToRenderer('transcription:error', { message: 'Post-processing failed' })
  })
}

// ── IPC registration ───────────────────────────────────────────────────────────

export function registerTranscriptionIpcHandlers(): void {
  /**
   * transcription:start
   * Routes to the backend selected in Settings → AI → Transcription:
   *   'elevenlabs' → ElevenLabs Scribe v2 (PCM 16kHz)  → audioFormat:'pcm'
   *   'deepgram'   → Deepgram Nova-3 (WebM/Opus)        → audioFormat:'webm'
   *   'macos'      → Swift SFSpeechRecognizer (offline)  → audioFormat:'none'
   */
  ipcMain.handle(
    'transcription:start',
    async (_event, { noteId, eventId }: { noteId: string; eventId: number }) => {
      const db = getDatabase()

      const modelRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('transcription_model') as { value: string } | undefined
      const model = (modelRow?.value || 'macos') as 'elevenlabs' | 'deepgram' | 'macos'

      const langRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('transcription_language') as { value: string } | undefined
      const language = langRow?.value || 'multi'

      if (model === 'macos') {
        // Offline: Swift SFSpeechRecognizer (always uses system locale)
        try {
          isTranscribing = true
          sessionNoteId = noteId
          sessionEventId = eventId
          sessionStartedAt = new Date().toISOString()
          await startSwiftTranscriber(noteId)
          console.log('[Transcription] Swift (macOS) started for note', noteId)
          return { ok: true, audioFormat: 'none' }
        } catch (err) {
          isTranscribing = false
          sessionNoteId = null
          sessionEventId = null
          sessionStartedAt = null
          const msg = err instanceof Error ? err.message : 'Unknown error'
          return { ok: false, error: msg }
        }
      }

      if (model === 'elevenlabs') {
        const elevenLabsRow = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('elevenlabs_api_key') as { value: string } | undefined
        const elevenLabsKey = elevenLabsRow?.value ?? ''
        if (!elevenLabsKey) {
          return { ok: false, error: 'ElevenLabs API key not configured. Add it in Settings → AI.' }
        }
        try {
          await startSession(noteId, eventId, elevenLabsKey, language, 'elevenlabs')
          return { ok: true, audioFormat: 'pcm' }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          return { ok: false, error: msg }
        }
      }

      // Deepgram Nova-3 — WebM/Opus audio from renderer
      const deepgramRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('deepgram_api_key') as { value: string } | undefined
      const deepgramKey = deepgramRow?.value ?? ''
      if (!deepgramKey) {
        return { ok: false, error: 'Deepgram API key not configured. Add it in Settings → AI.' }
      }
      try {
        await startSession(noteId, eventId, deepgramKey, language, 'deepgram')
        return { ok: true, audioFormat: 'webm' }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        return { ok: false, error: msg }
      }
    },
  )

  /** transcription:stop — stops whichever backend is active and kicks off post-processing */
  ipcMain.handle('transcription:stop', async () => {
    if (isSwiftTranscriberActive()) {
      const endedAt = new Date().toISOString()
      await stopSwiftTranscriber(sessionStartedAt ?? undefined, endedAt)
      isTranscribing = false
      sessionNoteId = null
      sessionEventId = null
      sessionStartedAt = null
    } else {
      await stopSession()
    }
    return { ok: true }
  })

  /**
   * transcription:audio-chunk — one-way; forwards audio bytes to the active cloud backend.
   * - ElevenLabs: wraps chunk as base64-encoded JSON (PCM Int16 from renderer)
   * - Deepgram:   sends raw binary bytes (WebM/Opus from MediaRecorder)
   * No-op when using the Swift fallback (binary captures audio directly).
   */
  ipcMain.on('transcription:audio-chunk', (_event, chunk: ArrayBuffer) => {
    if (!isTranscribing || isSwiftTranscriberActive()) return
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      if (activeBackend === 'elevenlabs') {
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(chunk).toString('base64') }))
      } else {
        ws.send(Buffer.from(chunk))
      }
    } catch (err) {
      console.error('[Transcription] Failed to send audio chunk:', err)
    }
  })

  /** transcription:status — returns current session state */
  ipcMain.handle('transcription:status', () => ({
    isTranscribing,
    noteId: sessionNoteId,
  }))

  /**
   * transcription:process — manual post-processing trigger.
   * Used when the renderer has already collected a full transcript
   * and just needs the AI summary + note update pipeline to run.
   */
  ipcMain.handle(
    'transcription:process',
    (_event, { noteId, transcript }: { noteId: string; transcript: string }) => {
      const db = getDatabase()
      const anthRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('anthropic_api_key') as { value: string } | undefined
      processTranscript(noteId, transcript, anthRow?.value ?? '').catch((err) => {
        console.error('[Transcription] Post-processing error:', err)
        pushToRenderer('transcription:error', { message: 'Post-processing failed' })
      })
      return { ok: true }
    },
  )
}
