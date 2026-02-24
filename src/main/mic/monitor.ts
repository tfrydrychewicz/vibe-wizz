/**
 * MicMonitor — spawns the Swift CoreAudio binary as a child process,
 * reads JSON events line-by-line, and emits typed events via micEvents.
 */

import { spawn, ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'

const isDev = process.env['NODE_ENV'] === 'development'

const MAX_RESTARTS = 5
const RESTART_DELAY_MS = 3000

let child: ChildProcess | null = null
let currentMicState = false
let restartCount = 0
let stopped = false

export interface MicChangeEvent {
  isActive: boolean
  deviceName: string | null
  timestamp: string
}

/** Internal event bus — subscribe in other main-process modules. */
export const micEvents = new EventEmitter()

function getBinaryPath(): string {
  if (isDev) {
    return join(process.cwd(), 'resources', 'MicMonitor')
  }
  return join(process.resourcesPath, 'MicMonitor')
}

interface MicRawEvent {
  type: 'mic_active' | 'mic_inactive' | 'log'
  timestamp: string
  deviceName?: string | null
  isActive: boolean
}

function handleEvent(event: MicRawEvent): void {
  if (event.type === 'log') {
    console.log('[MicMonitor] device:', event.deviceName)
    return
  }

  const newState = event.type === 'mic_active'
  if (newState === currentMicState) return

  currentMicState = newState
  const payload: MicChangeEvent = {
    isActive: newState,
    deviceName: event.deviceName ?? null,
    timestamp: event.timestamp,
  }
  micEvents.emit('change', payload)
  console.log(`[MicMonitor] ${newState ? 'mic_active' : 'mic_inactive'} — ${event.deviceName ?? 'unknown'}`)
}

function spawnBinary(): void {
  const binaryPath = getBinaryPath()

  if (!existsSync(binaryPath)) {
    console.warn(`[MicMonitor] Binary not found at ${binaryPath} — mic detection disabled`)
    return
  }

  child = spawn(binaryPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })

  let buffer = ''

  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const event = JSON.parse(trimmed) as MicRawEvent
        handleEvent(event)
      } catch {
        console.warn('[MicMonitor] Failed to parse line:', trimmed)
      }
    }
  })

  child.stderr?.on('data', (chunk: Buffer) => {
    console.warn('[MicMonitor] stderr:', chunk.toString().trim())
  })

  child.on('exit', (code, signal) => {
    child = null
    if (stopped) return

    console.warn(`[MicMonitor] Process exited (code=${code}, signal=${signal})`)
    if (restartCount < MAX_RESTARTS) {
      restartCount++
      console.log(`[MicMonitor] Restarting in ${RESTART_DELAY_MS}ms (attempt ${restartCount}/${MAX_RESTARTS})`)
      setTimeout(spawnBinary, RESTART_DELAY_MS)
    } else {
      console.error('[MicMonitor] Max restarts reached — mic detection disabled')
    }
  })

  child.on('error', (err) => {
    console.error('[MicMonitor] Failed to spawn binary:', err.message)
  })

  console.log(`[MicMonitor] Started — PID ${child.pid}`)
}

export function startMicMonitor(): void {
  stopped = false
  restartCount = 0
  spawnBinary()
}

export function stopMicMonitor(): void {
  stopped = true
  if (child) {
    child.kill('SIGTERM')
    child = null
  }
}

export function getMicStatus(): boolean {
  return currentMicState
}
