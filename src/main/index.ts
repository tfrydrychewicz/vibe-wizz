import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { initDatabase, closeDatabase, getDatabase } from './db/index'
import { registerDbIpcHandlers } from './db/ipc'
import { setMainWindow, pushToRenderer } from './push'
import { startMicMonitor, stopMicMonitor, getMicStatus } from './mic/monitor'
import { createMeetingWindow, destroyMeetingWindow } from './mic/meetingWindow'
import { registerTranscriptionIpcHandlers } from './transcription/session'
import { scheduleNightlyClusterBatch } from './embedding/scheduler'
import { processDirtyNotes } from './embedding/pipeline'
import { startCalendarSyncScheduler } from './calendar/sync/scheduler'

const isDev = process.env['NODE_ENV'] === 'development'

let mainWindow: BrowserWindow | null = null
let isQuitting = false

ipcMain.handle('window:toggle-maximize', () => {
  const win = mainWindow
  if (!win) return
  if (win.isMaximized()) {
    win.unmaximize()
  } else {
    win.maximize()
  }
})

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset', // native macOS traffic lights
    backgroundColor: '#1a1a1a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  setMainWindow(mainWindow)

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

ipcMain.handle('mic:status', () => ({ isActive: getMicStatus() }))

app.whenReady().then(() => {
  initDatabase()
  processDirtyNotes().catch(console.error)
  registerDbIpcHandlers()
  registerTranscriptionIpcHandlers()
  createWindow()
  startMicMonitor()
  createMeetingWindow()
  scheduleNightlyClusterBatch()
  startCalendarSyncScheduler()

  app.on('activate', () => {
    // On macOS re-create a window when the dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', async (event) => {
  if (isQuitting) return  // 2nd call after our app.quit() — let Electron proceed
  event.preventDefault()
  isQuitting = true

  stopMicMonitor()
  destroyMeetingWindow()

  // Flush dirty L1/L2 embeddings before closing — max 5 seconds,
  // then fall back to startup recovery for any remainder
  try {
    const db = getDatabase()
    const dirtyCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM notes WHERE embedding_dirty = 1 AND archived_at IS NULL`
        )
        .get() as { c: number }
    ).c
    if (dirtyCount > 0) {
      pushToRenderer('app:quit-embeddings-start', { count: dirtyCount })
      // Yield one tick so the renderer can process the IPC event and paint the overlay
      // before processDirtyNotes() (which may resolve in ~0ms) triggers app.quit().
      await new Promise<void>((r) => setTimeout(r, 100))
    }
    await Promise.race([
      processDirtyNotes(),
      new Promise<void>((r) => setTimeout(r, 5000)),
    ])
  } catch {
    // ignore — startup recovery handles any remaining dirty notes
  }

  closeDatabase()
  app.exit()
})

app.on('window-all-closed', () => {
  // On macOS the app stays active until the user quits explicitly with Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})
