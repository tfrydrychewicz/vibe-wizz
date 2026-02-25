/**
 * AudioCapture module — spawns AudioCapture.app (Core Audio Taps binary) that
 * captures system audio output + microphone input, mixes them to PCM Int16 16kHz
 * mono, and streams 256ms chunks as base64-encoded JSON lines on stdout.
 *
 * Protocol (stdout JSON lines from the binary):
 *   {"type":"ready"}                              — binary ready, recording started
 *   {"type":"audio_chunk","data":"<base64pcm>"}   — 256ms PCM Int16 16kHz mono chunk
 *   {"type":"error","message":"..."}              — error (fatal on startup)
 *
 * Requires macOS 14.2+ and "Screen & System Audio Recording" permission.
 * Run `npm run build:audiocapture` to build the binary before first use.
 */

import { spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

const isDev = process.env['NODE_ENV'] === 'development'

let child: ChildProcess | null = null

function getBinaryPath(): string {
  const base = isDev ? join(process.cwd(), 'resources') : process.resourcesPath
  return join(base, 'AudioCapture.app', 'Contents', 'MacOS', 'AudioCapture')
}

interface AudioCaptureEvent {
  type: 'ready' | 'audio_chunk' | 'error'
  data?: string
  message?: string
}

/**
 * Start the AudioCapture binary.
 * Resolves when the binary emits {"type":"ready"}.
 * onChunk is called with each decoded PCM Buffer (Int16 16kHz mono).
 * onError is called on non-fatal runtime errors.
 * Rejects if the binary is not found, fails to start, or emits an error before ready.
 */
export function startAudioCapture(
  onChunk: (buf: Buffer) => void,
  onError: (msg: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const binaryPath = getBinaryPath()

    if (!existsSync(binaryPath)) {
      reject(
        new Error(
          'AudioCapture.app not found. Run: npm run build:audiocapture\n' +
            `(expected at: ${binaryPath})`,
        ),
      )
      return
    }

    child = spawn(binaryPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })

    let lineBuf = ''
    let started = false

    child.stdout?.on('data', (rawChunk: Buffer) => {
      lineBuf += rawChunk.toString()
      const lines = lineBuf.split('\n')
      lineBuf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const ev = JSON.parse(trimmed) as AudioCaptureEvent
          if (ev.type === 'ready') {
            if (!started) {
              started = true
              resolve()
            }
          } else if (ev.type === 'audio_chunk' && ev.data) {
            onChunk(Buffer.from(ev.data, 'base64'))
          } else if (ev.type === 'error') {
            const msg = ev.message ?? 'AudioCapture error'
            console.error('[AudioCapture]', msg)
            if (!started) {
              started = true
              child = null
              reject(new Error(msg))
            } else {
              onError(msg)
            }
          }
        } catch {
          console.warn('[AudioCapture] Could not parse line:', trimmed)
        }
      }
    })

    child.stderr?.on('data', (rawChunk: Buffer) => {
      console.warn('[AudioCapture] stderr:', rawChunk.toString().trim())
    })

    child.on('error', (err) => {
      console.error('[AudioCapture] Spawn error:', err.message)
      if (!started) {
        started = true
        child = null
        reject(err)
      } else {
        onError(err.message)
      }
    })

    child.on('exit', (code, signal) => {
      child = null
      if (!started) {
        started = true
        reject(new Error(`AudioCapture exited before ready (code=${code}, signal=${signal})`))
      } else {
        console.log(`[AudioCapture] Process exited (code=${code}, signal=${signal})`)
      }
    })
  })
}

/**
 * Stop the AudioCapture binary by sending SIGTERM.
 * The binary will flush any remaining audio and exit cleanly.
 */
export function stopAudioCapture(): void {
  if (!child) return
  const c = child
  child = null
  try {
    c.kill('SIGTERM')
  } catch {
    // Process may have already exited
  }
}
