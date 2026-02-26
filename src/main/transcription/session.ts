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

import { ipcMain, app, shell } from 'electron'
import WebSocket from 'ws'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getDatabase } from '../db/index'
import { pushToRenderer } from '../push'
import { processTranscript } from './postProcessor'
import {
  startSwiftTranscriber,
  stopSwiftTranscriber,
  isSwiftTranscriberActive,
} from './swiftTranscriber'
import { startAudioCapture, stopAudioCapture } from './audioCapture'

// ── Session state ──────────────────────────────────────────────────────────────

let isTranscribing = false

export function isTranscriptionActive(): boolean {
  return isTranscribing
}
let sessionNoteId: string | null = null
let sessionEventId: number | null = null
let sessionStartedAt: string | null = null
let ws: WebSocket | null = null
let accumulatedTranscript = ''
// Most recent non-final transcript (shown while streaming, not included in accumulated)
let partialBuffer = ''
// Which cloud backend is currently active
let activeBackend: 'deepgram' | 'elevenlabs' | 'elevenlabs-batch' = 'deepgram'
// PCM audio chunks buffered during an ElevenLabs Batch session
let batchAudioChunks: Buffer[] = []
// Speaker-labeled segments from Deepgram diarization: [{speakerId, text}]
let speakerSegments: Array<{ speakerId: number; text: string }> = []
// Whether this session uses AudioCapture.app (system audio + mic) instead of renderer audio
let usingSystemAudio = false
// Debug audio recording — when save_debug_audio='true', all audio chunks are accumulated
// and written to a WAV/WebM file in the debug-audio folder when the session ends.
let collectDebugAudio = false
let debugAudioChunks: Buffer[] = []

/** Write accumulated audio chunks to a debug WAV or WebM file in userData/debug-audio/. */
function saveDebugAudioFile(chunks: Buffer[], format: 'pcm' | 'webm'): void {
  try {
    const dir = join(app.getPath('userData'), 'debug-audio')
    mkdirSync(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    if (format === 'pcm') {
      const wav = buildWavBuffer(chunks)
      const filePath = join(dir, `audio-${ts}.wav`)
      writeFileSync(filePath, wav)
      console.log('[Transcription] Debug audio saved:', filePath)
    } else {
      const raw = Buffer.concat(chunks)
      const filePath = join(dir, `audio-${ts}.webm`)
      writeFileSync(filePath, raw)
      console.log('[Transcription] Debug audio saved:', filePath)
    }
  } catch (err) {
    console.error('[Transcription] Failed to save debug audio:', err)
  }
}

/** Build a speaker-labeled transcript string from accumulated diarization segments.
 *  Consecutive segments from the same speaker are merged into one block.
 *  Example output:
 *    [Speaker 0]: Hello, how are you?
 *    [Speaker 1]: I'm good. Let's get started.
 */
function buildSpeakerLabeledTranscript(): string {
  const merged: Array<{ speakerId: number; text: string }> = []
  for (const seg of speakerSegments) {
    const last = merged[merged.length - 1]
    if (last && last.speakerId === seg.speakerId) {
      last.text += ' ' + seg.text
    } else {
      merged.push({ speakerId: seg.speakerId, text: seg.text })
    }
  }
  return merged.map((s) => `[Speaker ${s.speakerId}]: ${s.text}`).join('\n')
}

// ── ElevenLabs Batch helpers ───────────────────────────────────────────────────

/** Build a minimal WAV container around raw PCM (16kHz, mono, Int16 LE). */
function buildWavBuffer(pcmChunks: Buffer[]): Buffer {
  const pcmData = Buffer.concat(pcmChunks)
  const sampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmData.length
  const wav = Buffer.allocUnsafe(44 + dataSize)
  let o = 0
  wav.write('RIFF', o); o += 4
  wav.writeUInt32LE(36 + dataSize, o); o += 4
  wav.write('WAVE', o); o += 4
  wav.write('fmt ', o); o += 4
  wav.writeUInt32LE(16, o); o += 4
  wav.writeUInt16LE(1, o); o += 2              // PCM
  wav.writeUInt16LE(numChannels, o); o += 2
  wav.writeUInt32LE(sampleRate, o); o += 4
  wav.writeUInt32LE(byteRate, o); o += 4
  wav.writeUInt16LE(blockAlign, o); o += 2
  wav.writeUInt16LE(bitsPerSample, o); o += 2
  wav.write('data', o); o += 4
  wav.writeUInt32LE(dataSize, o); o += 4
  pcmData.copy(wav, o)
  return wav
}

interface ElevenLabsBatchWord {
  type: 'word' | 'spacing' | 'audio_event'
  text: string
  start?: number
  end?: number
  speaker_id?: string
}

interface ElevenLabsBatchResponse {
  text: string
  words?: ElevenLabsBatchWord[]
}

/**
 * POST a recorded PCM buffer to the ElevenLabs Scribe v2 Batch API with diarization.
 * Returns a speaker-labeled transcript (e.g. "[Speaker 0]: Hello\n[Speaker 1]: Hi")
 * or plain text if no diarization data is returned.
 */
async function stopElevenLabsBatch(
  chunks: Buffer[],
  apiKey: string,
  language: string,
): Promise<string> {
  if (chunks.length === 0) return ''

  const wavBuffer = buildWavBuffer(chunks)
  const formData = new FormData()
  formData.append('file', new Blob([new Uint8Array(wavBuffer)], { type: 'audio/wav' }), 'recording.wav')
  formData.append('model_id', 'scribe_v2')
  formData.append('diarize', 'true')
  if (language !== 'multi') formData.append('language_code', language)

  console.log(
    `[Transcription] ElevenLabs Batch: uploading ${(wavBuffer.length / 1024 / 1024).toFixed(1)} MB`,
  )

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: formData,
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`ElevenLabs Batch API error (${res.status}): ${body}`)
  }

  const data = (await res.json()) as ElevenLabsBatchResponse
  const words = data.words ?? []
  const hasDiarization = words.some((w) => w.type === 'word' && w.speaker_id)

  if (!hasDiarization) {
    console.log('[Transcription] ElevenLabs Batch: no diarization data, returning plain text')
    return data.text || ''
  }

  // Map speaker_id strings ("speaker_0", "speaker_1") → sequential integers
  const speakerId2Int = new Map<string, number>()
  const segments: Array<{ speakerId: number; text: string }> = []
  let currentSpeaker: number | null = null
  let currentText = ''

  for (const w of words) {
    if (w.type !== 'word' || !w.speaker_id) continue
    if (!speakerId2Int.has(w.speaker_id)) speakerId2Int.set(w.speaker_id, speakerId2Int.size)
    const id = speakerId2Int.get(w.speaker_id)!
    if (id !== currentSpeaker) {
      if (currentSpeaker !== null && currentText.trim())
        segments.push({ speakerId: currentSpeaker, text: currentText.trim() })
      currentSpeaker = id
      currentText = w.text
    } else {
      currentText += ' ' + w.text
    }
  }
  if (currentSpeaker !== null && currentText.trim())
    segments.push({ speakerId: currentSpeaker, text: currentText.trim() })

  if (segments.length === 0) return data.text || ''

  // Merge consecutive same-speaker segments
  const merged: typeof segments = []
  for (const seg of segments) {
    const last = merged[merged.length - 1]
    if (last && last.speakerId === seg.speakerId) last.text += ' ' + seg.text
    else merged.push({ ...seg })
  }

  const labeled = merged.map((s) => `[Speaker ${s.speakerId}]: ${s.text}`).join('\n')
  console.log(`[Transcription] ElevenLabs Batch: ${merged.length} speakers detected`)
  return labeled
}

// ── Unexpected WebSocket close handler ────────────────────────────────────────

/**
 * Called when a cloud backend WebSocket closes while a session is still active
 * (i.e. not triggered by our own cleanupSession / stopSession call).
 * Saves whatever transcript was accumulated and kicks off post-processing so
 * the user doesn't lose their transcript.
 */
function handleUnexpectedClose(code: number): void {
  if (!isTranscribing) return   // graceful stop already cleaned up

  console.warn('[Transcription] WebSocket closed unexpectedly (code:', code, ')')
  pushToRenderer('transcription:error', {
    message: `Transcription service disconnected (code ${code}). Saving partial transcript.`,
  })

  const noteId = sessionNoteId!
  const startedAt = sessionStartedAt
  const eventId = sessionEventId
  const finalText = accumulatedTranscript + (partialBuffer ? ' ' + partialBuffer : '')
  const labeledText = speakerSegments.length > 0 ? buildSpeakerLabeledTranscript() : ''
  const endedAt = new Date().toISOString()
  cleanupSession()   // sets isTranscribing=false, ws=null, etc.

  if (!finalText.trim()) return
  const db = getDatabase()
  const anthKey =
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic_api_key') as
      | { value: string }
      | undefined)?.value ?? ''
  const backgroundModel =
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('model_background') as { value: string } | undefined)
      ?.value || 'claude-haiku-4-5-20251001'
  const attendeeNames = readAttendeeNames(eventId)
  processTranscript(noteId, labeledText || finalText, anthKey, startedAt ?? undefined, endedAt, attendeeNames, backgroundModel).catch(
    (err) => {
      console.error('[Transcription] Post-processing error after unexpected close:', err)
      pushToRenderer('transcription:error', { message: 'Post-processing failed' })
    },
  )
}

// ── Deepgram connection ────────────────────────────────────────────────────────

const DEEPGRAM_BASE_URL = 'wss://api.deepgram.com/v1/listen'

interface DeepgramWord {
  word: string
  punctuated_word?: string
  speaker?: number
}

interface DeepgramResult {
  type: string
  is_final: boolean
  channel: {
    alternatives: Array<{ transcript: string; words?: DeepgramWord[] }>
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
          // Parse diarized words into speaker segments
          const words = msg.channel?.alternatives?.[0]?.words
          if (words && words.length > 0 && words.some((w) => w.speaker !== undefined)) {
            let segText = ''
            let segSpeaker = words[0].speaker ?? 0
            for (const w of words) {
              const wordSpeaker = w.speaker ?? segSpeaker
              const wordText = w.punctuated_word || w.word
              if (wordSpeaker !== segSpeaker && segText) {
                speakerSegments.push({ speakerId: segSpeaker, text: segText.trim() })
                segText = wordText
                segSpeaker = wordSpeaker
              } else {
                segText += (segText ? ' ' : '') + wordText
              }
            }
            if (segText) speakerSegments.push({ speakerId: segSpeaker, text: segText.trim() })
          }
        } else {
          partialBuffer = text
          pushToRenderer('transcription:partial', { text, isFinal: false })
        }
      } catch {
        // Ignore parse errors from Deepgram metadata messages
      }
    })

    ws.on('close', (code) => {
      console.log('[Transcription] Deepgram WebSocket closed (code:', code, ')')
      handleUnexpectedClose(code)
    })
  })
}

/**
 * Like openDeepgramSocket() but accepts raw PCM Int16 16kHz mono (linear16 encoding)
 * instead of WebM/Opus. Used when AudioCapture.app provides the audio stream.
 */
function openDeepgramSocketPcm(apiKey: string, language: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      model: 'nova-3',
      language,
      punctuate: 'true',
      smart_format: 'true',
      diarize: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
    })
    const url = `${DEEPGRAM_BASE_URL}?${params.toString()}`
    console.log('[Transcription] Connecting to Deepgram (PCM):', url.replace(/Token [^&]+/, 'Token ***'))

    ws = new WebSocket(url, {
      headers: { Authorization: `Token ${apiKey}` },
    })

    ws.on('open', () => {
      console.log('[Transcription] Deepgram PCM WebSocket connected (language:', language, ')')
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
      console.error('[Transcription] Deepgram PCM WS error:', err.message)
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
          const words = msg.channel?.alternatives?.[0]?.words
          if (words && words.length > 0 && words.some((w) => w.speaker !== undefined)) {
            let segText = ''
            let segSpeaker = words[0].speaker ?? 0
            for (const w of words) {
              const wordSpeaker = w.speaker ?? segSpeaker
              const wordText = w.punctuated_word || w.word
              if (wordSpeaker !== segSpeaker && segText) {
                speakerSegments.push({ speakerId: segSpeaker, text: segText.trim() })
                segText = wordText
                segSpeaker = wordSpeaker
              } else {
                segText += (segText ? ' ' : '') + wordText
              }
            }
            if (segText) speakerSegments.push({ speakerId: segSpeaker, text: segText.trim() })
          }
        } else {
          partialBuffer = text
          pushToRenderer('transcription:partial', { text, isFinal: false })
        }
      } catch {
        // Ignore parse errors from Deepgram metadata messages
      }
    })

    ws.on('close', (code) => {
      console.log('[Transcription] Deepgram PCM WebSocket closed (code:', code, ')')
      handleUnexpectedClose(code)
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

    ws.on('close', (code) => {
      console.log('[Transcription] ElevenLabs WebSocket closed (code:', code, ')')
      handleUnexpectedClose(code)
    })
  })
}

// ── Session lifecycle ──────────────────────────────────────────────────────────

function cleanupSession(): void {
  if (usingSystemAudio) stopAudioCapture()
  // Save debug audio before resetting state (needs activeBackend + usingSystemAudio)
  if (collectDebugAudio && debugAudioChunks.length > 0) {
    const fmt = activeBackend === 'deepgram' && !usingSystemAudio ? 'webm' : 'pcm'
    saveDebugAudioFile(debugAudioChunks, fmt)
  }
  usingSystemAudio = false
  collectDebugAudio = false
  debugAudioChunks = []
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
  speakerSegments = []
  batchAudioChunks = []
}

/** Read attendee names from the calendar event linked to the session. */
function readAttendeeNames(eventId: number | null): string[] {
  if (!eventId) return []
  const db = getDatabase()
  const event = db
    .prepare('SELECT attendees FROM calendar_events WHERE id = ?')
    .get(eventId) as { attendees: string } | undefined
  if (!event?.attendees) return []
  try {
    const parsed = JSON.parse(event.attendees) as Array<{ name: string; email?: string }>
    return parsed.map((a) => a.name).filter(Boolean)
  } catch {
    return []
  }
}

async function startSession(
  noteId: string,
  eventId: number,
  apiKey: string,
  language: string,
  backend: 'deepgram' | 'elevenlabs' | 'elevenlabs-batch',
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
  speakerSegments = []
  batchAudioChunks = []
  activeBackend = backend
  if (backend === 'elevenlabs') {
    await openElevenLabsSocket(apiKey, language)
    console.log('[Transcription] ElevenLabs Realtime session started for note', noteId)
  } else if (backend === 'deepgram') {
    await openDeepgramSocket(apiKey, language)
    console.log('[Transcription] Deepgram session started for note', noteId)
  } else {
    // elevenlabs-batch: no WebSocket — audio chunks buffered locally until stop
    console.log('[Transcription] ElevenLabs Batch session started for note', noteId)
  }
  isTranscribing = true
}

async function stopSession(): Promise<void> {
  if (!isTranscribing) return
  // In batch mode ws is null; for WS backends we need ws to be present
  if (activeBackend !== 'elevenlabs-batch' && !ws) return

  const noteId = sessionNoteId!
  const startedAt = sessionStartedAt
  const eventId = sessionEventId

  // ── ElevenLabs Batch path ───────────────────────────────────────────────────
  if (activeBackend === 'elevenlabs-batch') {
    const chunks = batchAudioChunks.slice()   // copy before cleanup clears array
    const endedAt = new Date().toISOString()
    cleanupSession()

    const db = getDatabase()
    const elKey =
      (db.prepare('SELECT value FROM settings WHERE key = ?').get('elevenlabs_api_key') as { value: string } | undefined)?.value ?? ''
    const language =
      (db.prepare('SELECT value FROM settings WHERE key = ?').get('transcription_language') as { value: string } | undefined)?.value || 'multi'
    const anthKey =
      (db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic_api_key') as { value: string } | undefined)?.value ?? ''
    const backgroundModel =
      (db.prepare('SELECT value FROM settings WHERE key = ?').get('model_background') as { value: string } | undefined)
        ?.value || 'claude-haiku-4-5-20251001'
    const attendeeNames = readAttendeeNames(eventId)

    stopElevenLabsBatch(chunks, elKey, language)
      .then((labeled) =>
        processTranscript(noteId, labeled, anthKey, startedAt ?? undefined, endedAt, attendeeNames, backgroundModel),
      )
      .catch((err) => {
        console.error('[Transcription] ElevenLabs Batch error:', err)
        pushToRenderer('transcription:error', {
          message: err instanceof Error ? err.message : 'Batch transcription failed',
        })
      })
    return
  }

  // ── WebSocket path (Deepgram or ElevenLabs Realtime) ────────────────────────
  const finalTranscript = accumulatedTranscript + (partialBuffer ? ' ' + partialBuffer : '')
  const labeledTranscript = speakerSegments.length > 0 ? buildSpeakerLabeledTranscript() : ''

  // ElevenLabs Realtime: flush the last segment before closing
  if (activeBackend === 'elevenlabs' && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true }))
      await new Promise<void>((resolve) => setTimeout(resolve, 500))
    } catch { /* ignore */ }
  }

  // Guard: if ElevenLabs closed the connection during the 500ms commit wait,
  // handleUnexpectedClose() already ran cleanupSession() and kicked off post-processing.
  if (!isTranscribing) return

  const endedAt = new Date().toISOString()
  if (ws && ws.readyState === WebSocket.OPEN) ws.close()
  cleanupSession()

  const db = getDatabase()
  const anthKey =
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('anthropic_api_key') as { value: string } | undefined)?.value ?? ''
  const backgroundModel =
    (db.prepare('SELECT value FROM settings WHERE key = ?').get('model_background') as { value: string } | undefined)
      ?.value || 'claude-haiku-4-5-20251001'
  const attendeeNames = readAttendeeNames(eventId)

  processTranscript(
    noteId,
    labeledTranscript || finalTranscript,
    anthKey,
    startedAt ?? undefined,
    endedAt,
    attendeeNames,
    backgroundModel,
  ).catch((err) => {
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

      // Debug audio: reset collection state before starting any backend
      const debugRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('save_debug_audio') as { value: string } | undefined
      collectDebugAudio = debugRow?.value === 'true'
      debugAudioChunks = []

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
        const diarizeRow = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('elevenlabs_diarize') as { value: string } | undefined
        const useBatch = diarizeRow?.value === 'true'
        const backend = useBatch ? 'elevenlabs-batch' : 'elevenlabs'
        const sysAudioRow = db
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get('system_audio_capture') as { value: string } | undefined
        const useSystemAudio = sysAudioRow?.value === 'true'
        try {
          await startSession(noteId, eventId, elevenLabsKey, language, backend)
          if (useSystemAudio) {
            await startAudioCapture(
              (buf: Buffer) => {
                if (!isTranscribing) return
                if (collectDebugAudio) debugAudioChunks.push(buf)
                if (activeBackend === 'elevenlabs-batch') {
                  batchAudioChunks.push(buf)
                  return
                }
                if (!ws || ws.readyState !== WebSocket.OPEN) return
                try {
                  ws.send(JSON.stringify({
                    message_type: 'input_audio_chunk',
                    audio_base_64: buf.toString('base64'),
                  }))
                } catch (e) {
                  console.error('[Transcription] Failed to forward audio chunk to ElevenLabs:', e)
                }
              },
              (msg: string) => {
                pushToRenderer('transcription:error', { message: `System audio: ${msg}` })
              },
            )
            usingSystemAudio = true
            return { ok: true, audioFormat: 'system-audio' }
          }
          return { ok: true, audioFormat: 'pcm' }
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error'
          return { ok: false, error: msg }
        }
      }

      // Deepgram Nova-3 — WebM/Opus from renderer (default) or PCM from AudioCapture.app
      const deepgramRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('deepgram_api_key') as { value: string } | undefined
      const deepgramKey = deepgramRow?.value ?? ''
      if (!deepgramKey) {
        return { ok: false, error: 'Deepgram API key not configured. Add it in Settings → AI.' }
      }
      const dgSysAudioRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('system_audio_capture') as { value: string } | undefined
      const dgUseSystemAudio = dgSysAudioRow?.value === 'true'
      try {
        if (dgUseSystemAudio) {
          // PCM path: open a linear16 WebSocket and feed raw PCM buffers from AudioCapture.app
          await openDeepgramSocketPcm(deepgramKey, language)
          sessionNoteId = noteId
          sessionEventId = eventId
          sessionStartedAt = new Date().toISOString()
          accumulatedTranscript = ''
          partialBuffer = ''
          speakerSegments = []
          batchAudioChunks = []
          activeBackend = 'deepgram'
          isTranscribing = true
          await startAudioCapture(
            (buf: Buffer) => {
              if (!isTranscribing) return
              if (collectDebugAudio) debugAudioChunks.push(buf)
              if (!ws || ws.readyState !== WebSocket.OPEN) return
              try { ws.send(buf) } catch (e) {
                console.error('[Transcription] Failed to forward PCM chunk to Deepgram:', e)
              }
            },
            (msg: string) => {
              pushToRenderer('transcription:error', { message: `System audio: ${msg}` })
            },
          )
          usingSystemAudio = true
          return { ok: true, audioFormat: 'system-audio' }
        }
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
   * - ElevenLabs Realtime: wraps chunk as base64-encoded JSON (PCM Int16 from renderer)
   * - ElevenLabs Batch:    buffers PCM chunks locally; uploaded as WAV on stop
   * - Deepgram:            sends raw binary bytes (WebM/Opus from MediaRecorder)
   * No-op when using the Swift fallback (binary captures audio directly).
   */
  ipcMain.on('transcription:audio-chunk', (_event, chunk: ArrayBuffer) => {
    if (!isTranscribing || isSwiftTranscriberActive() || usingSystemAudio) return
    const buf = Buffer.from(chunk)
    if (collectDebugAudio) debugAudioChunks.push(buf)
    if (activeBackend === 'elevenlabs-batch') {
      batchAudioChunks.push(buf)
      return
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    try {
      if (activeBackend === 'elevenlabs') {
        ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: buf.toString('base64') }))
      } else {
        ws.send(buf)
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
      const bgModelRow = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get('model_background') as { value: string } | undefined
      const bgModel = bgModelRow?.value || 'claude-haiku-4-5-20251001'
      processTranscript(noteId, transcript, anthRow?.value ?? '', undefined, undefined, undefined, bgModel).catch((err) => {
        console.error('[Transcription] Post-processing error:', err)
        pushToRenderer('transcription:error', { message: 'Post-processing failed' })
      })
      return { ok: true }
    },
  )

  /** debug:open-audio-folder — opens the debug-audio directory in Finder. */
  ipcMain.handle('debug:open-audio-folder', () => {
    const dir = join(app.getPath('userData'), 'debug-audio')
    mkdirSync(dir, { recursive: true })
    shell.openPath(dir)
  })

  /** debug:get-audio-folder — returns the absolute path to the debug-audio directory. */
  ipcMain.handle('debug:get-audio-folder', () => {
    return join(app.getPath('userData'), 'debug-audio')
  })
}
