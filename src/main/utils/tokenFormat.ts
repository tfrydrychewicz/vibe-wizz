/**
 * Shared utilities for the {{entity:uuid:Name}} / {{note:uuid:Name}} token format.
 *
 * These tokens are used across all AI surfaces (inline AI, chat, daily brief) to embed
 * entity and note references that the renderer converts to interactive chips.
 *
 * Single source of truth — import from here instead of duplicating the UUID pattern
 * or building token strings manually in each module.
 */

/** UUID v4 pattern string (no anchors, suitable for embedding inside larger regexes). */
export const UUID_RE_STR =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

/**
 * Matches {{entity:uuid:Name}} tokens (with global flag).
 *   Group 1 = UUID
 *   Group 2 = entity name (any char except `}`)
 *
 * Uses [^}]* rather than .*? to avoid lazy-matching edge cases with names
 * that contain colons, arrows (->), or other special characters.
 * Entity/note names should never contain `}`, so [^}]* is safe and predictable.
 */
export const ENTITY_TOKEN_RE = new RegExp(
  `\\{\\{entity:(${UUID_RE_STR}):([^}]*)\\}\\}`,
  'g',
)

/**
 * Matches {{note:uuid:Title}} tokens (with global flag).
 *   Group 1 = UUID
 *   Group 2 = note title (any char except `}`)
 */
export const NOTE_TOKEN_RE = new RegExp(
  `\\{\\{note:(${UUID_RE_STR}):([^}]*)\\}\\}`,
  'g',
)

/** Construct an {{entity:uuid:Name}} token string. */
export function entityToken(id: string, name: string): string {
  return `{{entity:${id}:${name}}}`
}

/** Construct a {{note:uuid:Title}} token string. */
export function noteToken(id: string, title: string): string {
  return `{{note:${id}:${title}}}`
}
