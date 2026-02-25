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
import { randomUUID } from 'crypto'
import { micEvents, type MicChangeEvent } from './monitor'
import { getDatabase } from '../db/index'
import { pushToRenderer } from '../push'
import { isTranscriptionActive } from '../transcription/session'

const isDev = process.env['NODE_ENV'] === 'development'

const DEBOUNCE_MS = 5000
// Window dimensions — sized to fit the card + shadow bleed (8px each side)
const WIN_W = 320
const WIN_H = 190

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

/**
 * Get or create a note for the given calendar event, returning its ID.
 * Uses linked_note_id if already set; otherwise creates a new note and links it.
 */
function getOrCreateNoteForEvent(eventId: number): string | null {
  const db = getDatabase()
  try {
    const event = db
      .prepare('SELECT id, title, start_at, linked_note_id FROM calendar_events WHERE id = ?')
      .get(eventId) as { id: number; title: string; start_at: string; linked_note_id: string | null } | undefined
    if (!event) {
      console.error('[MeetingWindow] Calendar event not found:', eventId)
      return null
    }
    if (event.linked_note_id) return event.linked_note_id

    // Build note title from template (default: "{date} - {title}")
    const templateRow = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('meeting_note_title_template') as { value: string } | undefined
    const template = templateRow?.value || '{date} - {title}'
    const dateStr = new Date(event.start_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
    const noteTitle = template.replace('{date}', dateStr).replace('{title}', event.title)

    // Create note
    const noteId = randomUUID()
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO notes (id, title, body, body_plain, source, language, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'transcript', 'en', ?, ?)`,
    ).run(noteId, noteTitle, JSON.stringify({ type: 'doc', content: [] }), '', now, now)

    // Link to event
    db.prepare('UPDATE calendar_events SET linked_note_id = ? WHERE id = ?').run(noteId, eventId)

    return noteId
  } catch (err) {
    console.error('[MeetingWindow] Failed to get/create note for event:', err)
    return null
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
        if (isTranscriptionActive()) return

        if (getAutoTranscribeSetting()) {
          // Auto-transcribe: find the current/upcoming event and open it
          triggerAutoTranscribe()
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

  ipcMain.on('meeting-prompt:transcribe', (_event, payload?: { eventId?: number }) => {
    dismissed = true
    hidePrompt()
    if (payload?.eventId != null) {
      triggerTranscriptionForEvent(payload.eventId)
    } else {
      console.warn('[MeetingWindow] transcribe IPC received without eventId')
    }
  })

  ipcMain.on('meeting-prompt:always-transcribe', (_event, payload?: { eventId?: number }) => {
    dismissed = true
    hidePrompt()
    try {
      getDatabase()
        .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run('auto_transcribe_meetings', 'true')
    } catch (err) {
      console.error('[MeetingWindow] Failed to save setting:', err)
    }
    if (payload?.eventId != null) {
      triggerTranscriptionForEvent(payload.eventId)
    } else {
      console.warn('[MeetingWindow] always-transcribe IPC received without eventId')
    }
  })
}

/** Open the note for the event in the main window and signal auto-start. */
function triggerTranscriptionForEvent(eventId: number): void {
  const noteId = getOrCreateNoteForEvent(eventId)
  if (!noteId) return
  pushToRenderer('transcription:open-note', { noteId, eventId, autoStart: true })
}

/** Called when auto_transcribe_meetings is true — find current/upcoming event and start. */
function triggerAutoTranscribe(): void {
  try {
    const db = getDatabase()
    const now = new Date().toISOString()
    const tenMinutesLater = new Date(Date.now() + 10 * 60 * 1000).toISOString()
    // Find current or upcoming event
    const event = db
      .prepare(
        `SELECT id FROM calendar_events
         WHERE (start_at <= ? AND end_at >= ?)
            OR (start_at > ? AND start_at <= ?)
         ORDER BY start_at ASC
         LIMIT 1`,
      )
      .get(now, now, now, tenMinutesLater) as { id: number } | undefined
    if (event) {
      triggerTranscriptionForEvent(event.id)
    } else {
      // No matching event — create a generic "New Meeting" event and start
      const start = new Date()
      const end = new Date(start.getTime() + 60 * 60 * 1000)
      const result = db
        .prepare(
          `INSERT INTO calendar_events (title, start_at, end_at, attendees)
           VALUES ('New Meeting', ?, ?, '[]')`,
        )
        .run(start.toISOString(), end.toISOString())
      triggerTranscriptionForEvent(result.lastInsertRowid as number)
    }
  } catch (err) {
    console.error('[MeetingWindow] triggerAutoTranscribe error:', err)
  }
}

export function destroyMeetingWindow(): void {
  clearDebounce()
  if (meetingWin && !meetingWin.isDestroyed()) {
    meetingWin.destroy()
    meetingWin = null
  }
}
