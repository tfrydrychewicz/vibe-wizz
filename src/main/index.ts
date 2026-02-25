import { app, BrowserWindow, shell, ipcMain } from 'electron'
import { join } from 'path'
import { initDatabase, closeDatabase } from './db/index'
import { registerDbIpcHandlers } from './db/ipc'
import { setMainWindow } from './push'
import { startMicMonitor, stopMicMonitor, getMicStatus } from './mic/monitor'
import { createMeetingWindow, destroyMeetingWindow } from './mic/meetingWindow'
import { registerTranscriptionIpcHandlers } from './transcription/session'
import { scheduleNightlyClusterBatch } from './embedding/scheduler'

const isDev = process.env['NODE_ENV'] === 'development'

let mainWindow: BrowserWindow | null = null

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
  registerDbIpcHandlers()
  registerTranscriptionIpcHandlers()
  createWindow()
  startMicMonitor()
  createMeetingWindow()
  scheduleNightlyClusterBatch()

  app.on('activate', () => {
    // On macOS re-create a window when the dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopMicMonitor()
  destroyMeetingWindow()
  closeDatabase()
})

app.on('window-all-closed', () => {
  // On macOS the app stays active until the user quits explicitly with Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})
