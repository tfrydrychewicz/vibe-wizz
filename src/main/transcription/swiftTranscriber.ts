/**
 * Swift Transcriber — spawns the SFSpeechRecognizer binary as a child process.
 *
 * Used as an offline fallback when no Deepgram API key is configured.
 * The binary captures microphone audio directly; no audio chunks from the
 * renderer are needed.
 *
 * Protocol (stdout JSON lines from binary):
 *   {"type":"ready"}                              — initialized, recording started
 *   {"type":"partial","text":"...","isFinal":bool} — live transcript update
 *   {"type":"error","message":"..."}              — non-fatal or startup error
 *
 * Unlike Deepgram, SFSpeechRecognizer returns the full accumulated text in
 * every partial update (not just the latest segment). The renderer displays
 * this as a growing partial; the final text at process exit is saved to the note.
 */

import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { getDatabase } from '../db/index'
import { pushToRenderer } from '../push'
import { processTranscript } from './postProcessor'

const isDev = process.env['NODE_ENV'] === 'development'

let child: ChildProcess | null = null
let transcribeNoteId: string | null = null
let lastFullText = '' // SFSpeechRecognizer gives full accumulated text per callback

function getBinaryPath(): string {
  const base = isDev ? join(process.cwd(), 'resources') : process.resourcesPath
  return join(base, 'Transcriber.app', 'Contents', 'MacOS', 'Transcriber')
}

export function isSwiftTranscriberActive(): boolean {
  return child !== null
}

interface TranscriberEvent {
  type: 'ready' | 'partial' | 'error'
  text?: string
  isFinal?: boolean
  message?: string
}

/**
 * Spawn the Transcriber binary and wait for it to signal "ready".
 * Resolves when the binary has initialized and audio recording has started.
 */
export function startSwiftTranscriber(noteId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const binaryPath = getBinaryPath()
    if (!existsSync(binaryPath)) {
      reject(
        new Error(
          'Transcriber.app not found. Run: npm run build:transcriber\n' +
            `(looked for: ${binaryPath})`,
        ),
      )
      return
    }

    // The binary uses SFSpeechRecognizer() (no locale arg) → always Locale.current
    child = spawn(binaryPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })
    transcribeNoteId = noteId
    lastFullText = ''

    let buffer = ''
    let started = false

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const event = JSON.parse(trimmed) as TranscriberEvent
          if (event.type === 'ready') {
            if (!started) {
              started = true
              resolve()
            }
          } else if (event.type === 'partial' && typeof event.text === 'string') {
            lastFullText = event.text // always the full accumulated text
            pushToRenderer('transcription:partial', {
              text: event.text,
              isFinal: event.isFinal ?? false,
            })
          } else if (event.type === 'error') {
            const msg = event.message ?? 'Transcription error'
            console.error('[SwiftTranscriber]', msg)
            if (!started) {
              started = true
              reject(new Error(msg))
            } else {
              pushToRenderer('transcription:error', { message: msg })
            }
          }
        } catch {
          console.warn('[SwiftTranscriber] Failed to parse line:', trimmed)
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      console.warn('[SwiftTranscriber] stderr:', chunk.toString().trim())
    })

    child.on('error', (err) => {
      console.error('[SwiftTranscriber] Spawn error:', err.message)
      if (!started) {
        started = true
        reject(err)
      }
    })

    child.on('exit', (code, signal) => {
      if (!started) {
        started = true
        reject(new Error(`Transcriber exited early (code=${code}, signal=${signal})`))
      }
    })
  })
}

/**
 * Send SIGTERM to the binary, wait for it to flush its final result and exit,
 * then run the post-meeting processing pipeline.
 */
export async function stopSwiftTranscriber(startedAt?: string, endedAt?: string): Promise<void> {
  const noteId = transcribeNoteId
  if (!child) return

  const currentChild = child
  child = null
  transcribeNoteId = null

  // Capture transcript after process drains stdout
  const captured = { text: lastFullText }

  await new Promise<void>((resolve) => {
    // 'close' fires after the process exits AND all stdio streams have closed,
    // guaranteeing we've received all stdout data including the final partial.
    currentChild.once('close', () => {
      captured.text = lastFullText
      lastFullText = ''
      resolve()
    })
    currentChild.kill('SIGTERM')
  })

  if (!noteId) return

  const db = getDatabase()
  const anthRow = db
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get('anthropic_api_key') as { value: string } | undefined

  processTranscript(noteId, captured.text, anthRow?.value ?? '', startedAt, endedAt).catch((err) => {
    console.error('[SwiftTranscriber] Post-processing error:', err)
    pushToRenderer('transcription:error', { message: 'Post-processing failed' })
  })
}
