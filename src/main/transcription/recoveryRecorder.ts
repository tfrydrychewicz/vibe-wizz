/**
 * Recovery recorder: persists audio chunks to disk during a transcription session
 * so that the audio can be retried if the STT service fails or the app crashes.
 *
 * Each session writes two files to {userData}/transcription-recovery/:
 *   session-{id}.raw  — raw audio bytes (PCM Int16 for PCM paths, WebM for WebM path)
 *   session-{id}.json — sidecar metadata { noteId, startedAt, format, filePath }
 *
 * The caller must:
 *   1. Call init() once after construction to create directories and the sidecar.
 *   2. Call push(chunk) for every audio chunk.
 *   3. Call cleanup() after successful transcription to delete both files.
 *
 * On app crash, orphaned .json sidecars are detected by listOrphanedSessions() and
 * surfaced to the user via a recovery banner on next launch.
 */

import { mkdirSync, appendFileSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { buildWavBuffer } from './wavUtils'

export type RecoveryFormat = 'pcm' | 'webm'

export interface RecoveryMeta {
  noteId: string
  startedAt: string   // ISO 8601
  format: RecoveryFormat
  filePath: string    // absolute path to .raw file
  metaPath: string    // absolute path to .json sidecar
}

const RECOVERY_DIR = 'transcription-recovery'
const TTL_MS = 7 * 24 * 60 * 60 * 1000   // 7 days

export class RecoveryRecorder {
  private chunks: Buffer[] = []
  private readonly filePath: string
  private readonly metaPath: string
  private readonly format: RecoveryFormat
  private readonly noteId: string
  private readonly startedAt: string

  constructor(
    sessionId: string,
    format: RecoveryFormat,
    noteId: string,
    userDataPath: string,
  ) {
    this.format = format
    this.noteId = noteId
    this.startedAt = new Date().toISOString()
    const dir = getRecoveryDir(userDataPath)
    this.filePath = join(dir, `session-${sessionId}.raw`)
    this.metaPath = join(dir, `session-${sessionId}.json`)
  }

  /** Create the recovery directory and write the sidecar JSON. */
  init(): void {
    mkdirSync(join(this.filePath, '..'), { recursive: true })
    const meta: RecoveryMeta = {
      noteId: this.noteId,
      startedAt: this.startedAt,
      format: this.format,
      filePath: this.filePath,
      metaPath: this.metaPath,
    }
    writeFileSync(this.metaPath, JSON.stringify(meta, null, 2))
  }

  /** Append a chunk to the in-memory buffer and persist it to disk. */
  push(chunk: Buffer): void {
    this.chunks.push(chunk)
    try {
      appendFileSync(this.filePath, chunk)
    } catch (err) {
      console.error('[Recovery] Failed to append chunk to recovery file:', err)
    }
  }

  /** Build a WAV buffer from all accumulated PCM chunks. Throws for WebM format. */
  buildWav(): Buffer {
    if (this.format !== 'pcm') throw new Error('buildWav() is only valid for PCM recordings')
    return buildWavBuffer(this.chunks)
  }

  /** Return all accumulated chunks (used for in-memory batch retry without disk read). */
  getChunks(): Buffer[] {
    return this.chunks
  }

  getFormat(): RecoveryFormat {
    return this.format
  }

  getFilePath(): string {
    return this.filePath
  }

  getNoteId(): string {
    return this.noteId
  }

  getStartedAt(): string {
    return this.startedAt
  }

  getMeta(): RecoveryMeta {
    return {
      noteId: this.noteId,
      startedAt: this.startedAt,
      format: this.format,
      filePath: this.filePath,
      metaPath: this.metaPath,
    }
  }

  /** Delete the recovery file and its sidecar. Call after successful transcription. */
  cleanup(): void {
    try { rmSync(this.filePath, { force: true }) } catch { /* ignore */ }
    try { rmSync(this.metaPath, { force: true }) } catch { /* ignore */ }
  }
}

// ── Static helpers ─────────────────────────────────────────────────────────────

export function getRecoveryDir(userDataPath: string): string {
  return join(userDataPath, RECOVERY_DIR)
}

/**
 * Scan the recovery directory for orphaned sidecar files.
 * Returns metadata for all sessions whose raw file still exists.
 */
export function listOrphanedSessions(userDataPath: string): RecoveryMeta[] {
  const dir = getRecoveryDir(userDataPath)
  try {
    mkdirSync(dir, { recursive: true })
    const files = readdirSync(dir)
    const results: RecoveryMeta[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = readFileSync(join(dir, f), 'utf-8')
        const meta = JSON.parse(raw) as RecoveryMeta
        // Only include if the raw audio file exists
        try { statSync(meta.filePath) } catch { continue }
        results.push(meta)
      } catch {
        // Corrupt sidecar — skip
      }
    }
    return results
  } catch {
    return []
  }
}

/** Delete both files for an orphaned session (e.g. user clicked Discard). */
export function deleteOrphanedSession(meta: RecoveryMeta): void {
  try { rmSync(meta.filePath, { force: true }) } catch { /* ignore */ }
  try { rmSync(meta.metaPath, { force: true }) } catch { /* ignore */ }
}

/** Remove recovery files older than TTL_MS (called at startup to prevent unbounded growth). */
export function cleanupExpiredSessions(userDataPath: string): void {
  const dir = getRecoveryDir(userDataPath)
  try {
    const files = readdirSync(dir)
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const metaPath = join(dir, f)
      try {
        const raw = readFileSync(metaPath, 'utf-8')
        const meta = JSON.parse(raw) as RecoveryMeta
        const age = now - new Date(meta.startedAt).getTime()
        if (age > TTL_MS) {
          deleteOrphanedSession(meta)
          console.log('[Recovery] Deleted expired session:', f)
        }
      } catch {
        // Corrupt sidecar — delete it too
        try { rmSync(metaPath, { force: true }) } catch { /* ignore */ }
      }
    }
  } catch {
    // Directory doesn't exist yet — fine
  }
}
