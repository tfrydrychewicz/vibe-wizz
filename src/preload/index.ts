import { contextBridge, ipcRenderer } from 'electron'

// Expose a typed API surface to the renderer via window.api
// Keep this minimal — expand as features are added
contextBridge.exposeInMainWorld('api', {
  send: (channel: string, data?: unknown): void => {
    ipcRenderer.send(channel, data)
  },
  invoke: (channel: string, data?: unknown): Promise<unknown> => {
    return ipcRenderer.invoke(channel, data)
  },
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void =>
      callback(...args)
    ipcRenderer.on(channel, handler)
    // Return an unsubscribe function
    return () => ipcRenderer.removeListener(channel, handler)
  }
})
