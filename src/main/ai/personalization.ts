/**
 * AI Personalization helper.
 *
 * Reads the user-authored preamble from the `settings` table and returns it
 * in a shape that every AI prompt-builder can consume:
 *
 *   - `preamble`   — plain text injected into the system prompt under "## About the user"
 *   - `entityIds`  — UUIDs of @mentioned entities; resolved to full entity context at call site
 *   - `noteIds`    — UUIDs of [[linked notes]]; resolved to pinned note context at call site
 *
 * All values gracefully degrade to empty/[] when no personalization has been saved.
 */

import type Database from 'better-sqlite3'

/** Maximum characters we inject from the preamble to avoid crowding out real context. */
const MAX_PREAMBLE_CHARS = 2000

export interface PersonalizationContext {
  /** Plain text of the user's self-description, ready for system prompt injection. */
  preamble: string
  /** Entity UUIDs mentioned in the preamble — caller merges into entity context resolution. */
  entityIds: string[]
  /** Note UUIDs linked in the preamble — caller merges into pinned notes. */
  noteIds: string[]
}

const EMPTY: PersonalizationContext = { preamble: '', entityIds: [], noteIds: [] }

/**
 * Read the personalization preamble from the settings table.
 * Returns EMPTY when nothing is configured — safe to call unconditionally.
 */
export function getPersonalizationPreamble(db: Database.Database): PersonalizationContext {
  try {
    const getText = db.prepare("SELECT value FROM settings WHERE key = 'ai_personalization_text'").get() as { value: string } | undefined
    const getEntityIds = db.prepare("SELECT value FROM settings WHERE key = 'ai_personalization_entity_ids'").get() as { value: string } | undefined
    const getNoteIds = db.prepare("SELECT value FROM settings WHERE key = 'ai_personalization_note_ids'").get() as { value: string } | undefined

    let preamble = getText?.value?.trim() ?? ''
    if (!preamble) return EMPTY

    // Truncate to budget — keeps token cost predictable
    if (preamble.length > MAX_PREAMBLE_CHARS) {
      preamble = preamble.slice(0, MAX_PREAMBLE_CHARS) + '…'
    }

    let entityIds: string[] = []
    try { entityIds = JSON.parse(getEntityIds?.value ?? '[]') as string[] } catch { /* ignore */ }

    let noteIds: string[] = []
    try { noteIds = JSON.parse(getNoteIds?.value ?? '[]') as string[] } catch { /* ignore */ }

    return { preamble, entityIds, noteIds }
  } catch (err) {
    console.warn('[Personalization] Failed to read settings:', err)
    return EMPTY
  }
}
