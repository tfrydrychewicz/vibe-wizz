/**
 * Meeting prompt window — a frameless, always-on-top BrowserWindow shown
 * when mic activity is detected for >5 seconds.
 *
 * Responsibilities:
 * - Create and manage the prompt BrowserWindow lifecycle
 * - Debounce mic:active events before showing (avoids false positives)
 * - Check auto_transcribe_meetings setting and skip prompt if enabled
 * - Push mic events to the prompt window's webContents for device name display
 * - Handle IPC from the prompt renderer (skip / transcribe / always-transcribe)
 */

import { BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { micEvents, type MicChangeEvent } from './monitor'
import { getDatabase } from '../db/index'

const isDev = process.env['NODE_ENV'] === 'development'

const DEBOUNCE_MS = 5000
// Window dimensions — sized to fit the card + shadow bleed (8px each side)
const WIN_W = 320
const WIN_H = 152

let meetingWin: BrowserWindow | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
// Dismissed for the current mic session — reset when mic goes inactive
let dismissed = false

function clearDebounce(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function getAutoTranscribeSetting(): boolean {
  try {
    const row = getDatabase()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('auto_transcribe_meetings') as { value: string } | undefined
    return row?.value === 'true'
  } catch {
    return false
  }
}

function pushToPromptWindow(channel: string, data?: unknown): void {
  if (meetingWin && !meetingWin.isDestroyed()) {
    meetingWin.webContents.send(channel, data)
  }
}

function showPrompt(deviceName: string | null, timestamp: string): void {
  if (!meetingWin || meetingWin.isDestroyed()) return

  const { workArea } = screen.getPrimaryDisplay()
  const x = Math.round(workArea.x + workArea.width - WIN_W - 20)
  const y = Math.round(workArea.y + 20)
  meetingWin.setPosition(x, y)

  // showInactive keeps focus on whatever app the user is in
  meetingWin.showInactive()

  // Push the mic:active payload so the renderer knows the device name
  pushToPromptWindow('mic:active', { deviceName, timestamp })
}

function hidePrompt(): void {
  if (meetingWin && !meetingWin.isDestroyed()) {
    meetingWin.hide()
  }
}

export function createMeetingWindow(): void {
  meetingWin = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    show: false,
    frame: false,
    backgroundColor: '#242424',
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  // 'floating' level keeps the window above fullscreen apps on macOS
  meetingWin.setAlwaysOnTop(true, 'floating')

  if (isDev) {
    meetingWin.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=meeting-prompt`)
  } else {
    meetingWin.loadFile(join(__dirname, '../renderer/index.html'), {
      query: { mode: 'meeting-prompt' },
    })
  }

  meetingWin.on('closed', () => {
    meetingWin = null
  })

  // ── Mic event handling ────────────────────────────────────────────────────

  micEvents.on('change', (event: MicChangeEvent) => {
    if (event.isActive) {
      dismissed = false
      clearDebounce()
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        if (dismissed) return

        if (getAutoTranscribeSetting()) {
          // Phase 3.2 — start Deepgram transcription (no-op for now)
          console.log('[MeetingWindow] Auto-transcribe triggered')
          return
        }

        showPrompt(event.deviceName, event.timestamp)
      }, DEBOUNCE_MS)
    } else {
      clearDebounce()
      dismissed = true
      if (meetingWin?.isVisible()) {
        // Signal the renderer to animate out, then hide after the animation
        pushToPromptWindow('mic:inactive', {})
        setTimeout(hidePrompt, 250)
      }
    }
  })

  // ── IPC from prompt renderer ──────────────────────────────────────────────

  ipcMain.on('meeting-prompt:skip', () => {
    dismissed = true
    hidePrompt()
  })

  ipcMain.on('meeting-prompt:transcribe', () => {
    dismissed = true
    hidePrompt()
    // Phase 3.2 — start Deepgram transcription
    console.log('[MeetingWindow] Transcription requested')
  })

  ipcMain.on('meeting-prompt:always-transcribe', () => {
    dismissed = true
    hidePrompt()
    try {
      getDatabase()
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('auto_transcribe_meetings', 'true')
      console.log('[MeetingWindow] auto_transcribe_meetings saved')
    } catch (err) {
      console.error('[MeetingWindow] Failed to save setting:', err)
    }
    // Phase 3.2 — start Deepgram transcription
    console.log('[MeetingWindow] Always-transcribe set, transcription requested')
  })
}

export function destroyMeetingWindow(): void {
  clearDebounce()
  if (meetingWin && !meetingWin.isDestroyed()) {
    meetingWin.destroy()
    meetingWin = null
  }
}
