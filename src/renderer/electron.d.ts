// Type declarations for the IPC bridge exposed via the preload script.
// Keep in sync with src/preload/index.ts.

interface Window {
  api: {
    send: (channel: string, data?: unknown) => void
    invoke: (channel: string, data?: unknown) => Promise<unknown>
    on: (channel: string, callback: (...args: unknown[]) => void) => () => void
  }
}
