/**
 * Push notification utility — sends IPC events from the main process to the renderer.
 * Lazy singleton: call setMainWindow() once after the BrowserWindow is created.
 */

import type { BrowserWindow } from 'electron'

let _mainWindow: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow): void {
  _mainWindow = win
  win.on('closed', () => {
    _mainWindow = null
  })
}

/** Send a one-way IPC event to the renderer. No-ops if the window is not ready. */
export function pushToRenderer(channel: string, data?: unknown): void {
  _mainWindow?.webContents.send(channel, data)
}
