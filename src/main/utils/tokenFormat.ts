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

/** Construct a {{action:uuid:Title}} token string. */
export function actionToken(id: string, title: string): string {
  return `{{action:${id}:${title}}}`
}

/** Construct a {{event:id:Label}} token string. */
export function eventToken(id: number | string, label: string): string {
  return `{{event:${id}:${label}}}`
}

/**
 * Scan AI-generated content for [task:UUID] and [event:ID] tokens emitted by
 * the model, resolve their labels from the provided context arrays, and replace
 * them with embedded-label tokens ({{action:UUID:Title}} / {{event:ID:Label}})
 * that the renderer converts to interactive chips via renderInline().
 *
 * Unresolvable tokens are left as plain text (graceful degradation).
 *
 * @param content        Raw AI response text.
 * @param actionItems    Action items available in context (need only id + title).
 * @param calendarEvents Calendar events available in context (need id, title, start_at).
 */
export function resolveActionEventTokens(
  content: string,
  actionItems: { id: string; title: string }[],
  calendarEvents: { id: number | string; title: string; start_at?: string }[],
): string {
  const taskMap = new Map<string, string>(actionItems.map((a) => [a.id, a.title]))
  const eventMap = new Map<string, { title: string; start_at?: string }>(
    calendarEvents.map((e) => [String(e.id), { title: e.title, start_at: e.start_at }]),
  )

  let out = content.replace(
    /\[task:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\]/gi,
    (_m, id: string) => {
      const title = taskMap.get(id)
      return title ? actionToken(id, title) : _m
    },
  )

  out = out.replace(/\[event:(\d+)\]/g, (_m, id: string) => {
    const ev = eventMap.get(id)
    if (!ev) return _m
    let label = ev.title
    if (ev.start_at) {
      try {
        const time = new Date(ev.start_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        label = `${ev.title} · ${time}`
      } catch { /* ignore formatting error */ }
    }
    return eventToken(id, label)
  })

  return out
}
