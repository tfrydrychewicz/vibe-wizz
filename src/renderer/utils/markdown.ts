/**
 * Shared Markdown → HTML renderer used by TodayView (Daily Brief),
 * EntityReviewPanel (Entity Reviews), and ChatSidebar (AI chat messages).
 *
 * Supports headings, bullet lists, task lists, horizontal rules,
 * bold/italic/code inline formatting, and Wizz-specific entity/note-link
 * tokens ({{entity:id:Name}}, @Name, {{note:id:Title}}, [[Title]])
 * rendered as interactive button chips.
 *
 * ── Canonical chip classes ─────────────────────────────────────────────────
 * ALL entity and note chips across the entire app MUST use these classes so
 * that (1) global CSS in style.css styles them uniformly, (2) useEntityChips
 * composable targets a single selector, and (3) click-handler event delegation
 * looks for a single class.  Never invent component-local chip classes.
 */

// ── HTML escaping ─────────────────────────────────────────────────────────────

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── Canonical chip class names (single source of truth) ──────────────────────

/** CSS class for all inline entity-reference chips rendered via v-html. */
export const ENTITY_CHIP_CLASS = 'wizz-entity-chip'

/** CSS class for all inline note-link chips rendered via v-html. */
export const NOTE_CHIP_CLASS = 'wizz-note-chip'

/** CSS class for all inline web-link chips rendered via v-html. */
export const WEB_LINK_CHIP_CLASS = 'wizz-web-chip'

/** CSS class for all inline action-item chips rendered via v-html. */
export const ACTION_CHIP_CLASS = 'wizz-action-chip'

/** CSS class for all inline calendar-event chips rendered via v-html. */
export const EVENT_CHIP_CLASS = 'wizz-event-chip'

/** CSS class for note-selection chips rendered via v-html (mirrors NoteSelectionChip.vue). */
export const SELECTION_CHIP_CLASS = 'wizz-note-selection-chip'

// ── Chip HTML generators (shared by renderInline + renderMessage) ─────────────

/**
 * Returns the HTML for a single entity chip.
 * @param id   Entity UUID — omit (undefined) when only the name is known.
 * @param name Human-readable entity name displayed in the chip.
 */
export function renderEntityChip(id: string | undefined, name: string): string {
  const idAttr = id ? ` data-entity-id="${escapeHtml(id)}"` : ''
  return `<button class="${ENTITY_CHIP_CLASS}"${idAttr} data-entity-name="${escapeHtml(name)}">@${escapeHtml(name)}</button>`
}

/**
 * Returns the HTML for a single note-link chip.
 * @param id    Note UUID — omit (undefined) when only the title is known.
 * @param title Human-readable note title displayed in the chip.
 */
export function renderNoteChip(id: string | undefined, title: string): string {
  const idAttr = id ? ` data-note-id="${escapeHtml(id)}"` : ''
  return `<button class="${NOTE_CHIP_CLASS}"${idAttr} data-note-title="${escapeHtml(title)}">${escapeHtml(title)}</button>`
}

/** Lucide AlignLeft SVG (12×12) inlined for note-selection chips. */
const ALIGN_LEFT_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<line x1="21" x2="3" y1="6" y2="6"/>' +
  '<line x1="15" x2="3" y1="12" y2="12"/>' +
  '<line x1="17" x2="3" y1="18" y2="18"/>' +
  '</svg>'

/**
 * Returns the HTML for a note-selection chip (non-removable, for history display).
 * Rendered as a <button> so clicks can navigate to the note and re-select the blocks.
 * @param noteId     UUID of the source note — attached as data-note-id for click delegation.
 * @param noteTitle  Human-readable title shown in the chip.
 * @param blockStart 1-based index of the first overlapping top-level block.
 * @param blockEnd   1-based index of the last overlapping top-level block.
 */
export function renderSelectionChip(noteId: string, noteTitle: string, blockStart: number, blockEnd: number): string {
  return (
    `<span class="${SELECTION_CHIP_CLASS}" data-note-id="${escapeHtml(noteId)}" data-block-start="${blockStart}" data-block-end="${blockEnd}">` +
    ALIGN_LEFT_SVG +
    `<span class="${SELECTION_CHIP_CLASS}__title">${escapeHtml(noteTitle)}</span>` +
    `<span class="${SELECTION_CHIP_CLASS}__range">(blocks ${blockStart}–${blockEnd})</span>` +
    `</span>`
  )
}

/** Lucide-style check-circle SVG (11×11) for action item chips. */
const CHECK_CIRCLE_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10"/>' +
  '<path d="M9 12l2 2 4-4"/>' +
  '</svg>'

/** Lucide-style calendar SVG (11×11) for calendar event chips. */
const CALENDAR_CHIP_SVG =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>' +
  '<line x1="16" y1="2" x2="16" y2="6"/>' +
  '<line x1="8" y1="2" x2="8" y2="6"/>' +
  '<line x1="3" y1="10" x2="21" y2="10"/>' +
  '</svg>'

/**
 * Returns the HTML for a single action-item chip.
 * @param id    Action item UUID — used for click delegation.
 * @param title Human-readable task title displayed in the chip.
 */
export function renderActionChip(id: string, title: string): string {
  return (
    `<button class="${ACTION_CHIP_CLASS}" data-action-id="${escapeHtml(id)}" ` +
    `data-action-title="${escapeHtml(title)}" title="${escapeHtml(title)}">` +
    `${CHECK_CIRCLE_SVG}${escapeHtml(title)}` +
    `</button>`
  )
}

/**
 * Returns the HTML for a single calendar-event chip.
 * @param id    Calendar event numeric ID — used for click delegation.
 * @param label Human-readable label (title + optional time) displayed in the chip.
 */
export function renderEventChip(id: string | number, label: string): string {
  return (
    `<button class="${EVENT_CHIP_CLASS}" data-event-id="${escapeHtml(String(id))}" ` +
    `data-event-label="${escapeHtml(label)}" title="${escapeHtml(label)}">` +
    `${CALENDAR_CHIP_SVG}${escapeHtml(label)}` +
    `</button>`
  )
}

/** Lucide-style globe SVG (16×16) inlined for zero runtime icon lookup. */
const GLOBE_SVG =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="10"/>' +
  '<line x1="2" y1="12" x2="22" y2="12"/>' +
  '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' +
  '</svg>'

/**
 * Returns the HTML for a web citation chip.
 * Clicking it calls `shell:open-external` to open the URL in the default browser.
 *
 * @param title  Link label shown in the chip.
 * @param url    The target URL — must start with http:// or https://.
 */
export function renderWebLinkChip(title: string, url: string): string {
  return (
    `<a href="#" class="${WEB_LINK_CHIP_CLASS}" ` +
    `data-web-url="${escapeHtml(url)}" title="${escapeHtml(url)}">` +
    `${GLOBE_SVG}${escapeHtml(title)}` +
    `</a>`
  )
}

// ── Inline renderer ───────────────────────────────────────────────────────────

/**
 * Renders a single line of inline markdown, resolving Wizz entity/note tokens
 * into interactive button chips with data-attributes for click handling.
 *
 * Entity chips:  data-entity-id (when ID known) + data-entity-name
 * Note chips:    data-note-id (when ID known) + data-note-title
 */
export function renderInline(raw: string): string {
  const entityItems: { id?: string; name: string }[] = []
  const noteLinkItems: { id?: string; title: string }[] = []

  const UUID_RE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

  // Pass 1a: {{entity:uuid:Name}} — ID embedded, no DB lookup needed at click time.
  // The leading `@?` absorbs any @ the AI or post-processor wrote before the token,
  // preventing `@WIZZENT0WIZZENT` from leaking into Pass 1b's @EntityName regex.
  const withEntityId = raw.replace(
    new RegExp(`@?\\{\\{entity:(${UUID_RE}):(.*?)\\}\\}`, 'g'),
    (_m, id: string, name: string) => {
      entityItems.push({ id, name: name.trim() })
      return `WIZZENT${entityItems.length - 1}WIZZENT`
    },
  )

  // Pass 1b: @EntityName — plain fallback, resolved by name at click time.
  // Supports "First Last" two-word names: the optional second segment requires an
  // uppercase start so "do something" is never captured as part of a name.
  const withEntityPlaceholders = withEntityId.replace(
    /@([A-Za-z\u00C0-\u04FF][^\s@,.:!?"()\[\]{}<>#\n]{0,59}(?:\s+[A-Z\u00C0-\u04FF][^\s@,.:!?"()\[\]{}<>#\n]{1,59})?)/g,
    (_m, name: string) => {
      const trimmed = name.replace(/[.,!?;:'")\]]+$/, '').trim()
      entityItems.push({ name: trimmed })
      return `WIZZENT${entityItems.length - 1}WIZZENT`
    },
  )

  // Pass 1c: {{note:uuid:Title}} — ID embedded
  const withNoteId = withEntityPlaceholders.replace(
    new RegExp(`\\{\\{note:(${UUID_RE}):(.*?)\\}\\}`, 'g'),
    (_m, id: string, title: string) => {
      noteLinkItems.push({ id, title: title.trim() })
      return `WIZZLINK${noteLinkItems.length - 1}WIZZLINK`
    },
  )

  // Pass 1d: [[NoteTitle]] — plain fallback, resolved by title at click time
  const withNoteLinkPlaceholders = withNoteId.replace(
    /\[\[([^\]]{1,200})\]\]/g,
    (_m, title: string) => {
      noteLinkItems.push({ title: title.trim() })
      return `WIZZLINK${noteLinkItems.length - 1}WIZZLINK`
    },
  )

  // Pass 1e: Markdown links [label](https://...) → web chip placeholders.
  // Must run before HTML escaping so brackets/parens are still raw.
  const webLinkItems: { title: string; url: string }[] = []
  const withWebLinkPlaceholders = withNoteLinkPlaceholders.replace(
    /\[([^\]]{1,300})\]\((https?:\/\/[^)]{1,2000})\)/g,
    (_m, label: string, url: string) => {
      webLinkItems.push({ title: label.trim(), url: url.trim() })
      return `WIZZURL${webLinkItems.length - 1}WIZZURL`
    },
  )

  // Pass 1f: bare https?:// URLs not already captured in a [label](url) link.
  // The negative lookbehind on `(` avoids matching inside already-processed links.
  const withBareUrlPlaceholders = withWebLinkPlaceholders.replace(
    /(?<!\()https?:\/\/[^\s<>"')\],]{4,}/g,
    (url: string) => {
      // Use hostname as display label
      const label = url.replace(/^https?:\/\//, '').split('/')[0].split('?')[0]
      webLinkItems.push({ title: label, url })
      return `WIZZURL${webLinkItems.length - 1}WIZZURL`
    },
  )

  // Pass 1g: {{action:UUID:Title}} — backend-resolved action item tokens
  const actionItems2: { id: string; title: string }[] = []
  const withActionPlaceholders = withBareUrlPlaceholders.replace(
    /\{\{action:([0-9a-fA-F-]{36}):([^}]*)\}\}/g,
    (_m, id: string, title: string) => {
      actionItems2.push({ id, title: title.trim() })
      return `WIZZACT${actionItems2.length - 1}WIZZACT`
    },
  )

  // Pass 1h: {{event:ID:Label}} — backend-resolved calendar event tokens
  const eventItems: { id: string; label: string }[] = []
  const withEventPlaceholders = withActionPlaceholders.replace(
    /\{\{event:(\d+):([^}]*)\}\}/g,
    (_m, id: string, label: string) => {
      eventItems.push({ id, label: label.trim() })
      return `WIZZEVT${eventItems.length - 1}WIZZEVT`
    },
  )

  // Pass 2: standard inline markdown on the HTML-escaped remainder
  const safe = escapeHtml(withEventPlaceholders)
  let result = safe
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')

  // Pass 3: substitute placeholders with styled button chips
  result = result.replace(/WIZZENT(\d+)WIZZENT/g, (_m, idxStr: string) => {
    const item = entityItems[Number(idxStr)]
    if (!item) return ''
    return renderEntityChip(item.id, item.name)
  })
  result = result.replace(/WIZZLINK(\d+)WIZZLINK/g, (_m, idxStr: string) => {
    const item = noteLinkItems[Number(idxStr)]
    if (!item) return ''
    return renderNoteChip(item.id, item.title)
  })
  result = result.replace(/WIZZURL(\d+)WIZZURL/g, (_m, idxStr: string) => {
    const item = webLinkItems[Number(idxStr)]
    if (!item) return ''
    return renderWebLinkChip(item.title, item.url)
  })
  result = result.replace(/WIZZACT(\d+)WIZZACT/g, (_m, idxStr: string) => {
    const item = actionItems2[Number(idxStr)]
    if (!item) return ''
    return renderActionChip(item.id, item.title)
  })
  result = result.replace(/WIZZEVT(\d+)WIZZEVT/g, (_m, idxStr: string) => {
    const item = eventItems[Number(idxStr)]
    if (!item) return ''
    return renderEventChip(item.id, item.label)
  })

  return result
}

// ── Block renderer ────────────────────────────────────────────────────────────

/**
 * Converts a Markdown string into an HTML string.
 *
 * Supported block elements:
 *   - Headings (# through ######)
 *   - Horizontal rules (---, ***, ___)
 *   - Task list items (- [ ] / - [x])
 *   - Bullet list items (- / *)
 *   - Paragraphs (fallback)
 *
 * Inline elements handled via renderInline():
 *   bold, italic, code, entity chips, note-link chips
 *
 * CSS classes emitted (must be styled by the consuming component via :deep()):
 *   .brief-task-list, .brief-task-item, .brief-checkbox(.checked), .brief-task-text
 *   .brief-bullet-list
 *   .brief-entity-ref, .brief-note-ref
 */
export function markdownToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let listType: 'ul-task' | 'ul' | null = null

  function closeList(): void {
    if (listType) { out.push('</ul>'); listType = null }
  }

  for (const line of lines) {
    const trimmed = line.trim()

    const hm = trimmed.match(/^(#{1,6})\s+(.+)$/)
    if (hm) {
      closeList()
      const level = hm[1].length
      out.push(`<h${level}>${renderInline(hm[2])}</h${level}>`)
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      closeList()
      out.push('<hr>')
      continue
    }

    const tm = trimmed.match(/^[-*]\s+\[([ xX])\]\s+(.+)$/)
    if (tm) {
      if (listType !== 'ul-task') { closeList(); out.push('<ul class="brief-task-list">'); listType = 'ul-task' }
      const checked = tm[1].toLowerCase() === 'x'
      out.push(
        `<li class="brief-task-item">` +
          `<span class="brief-checkbox${checked ? ' checked' : ''}">${checked ? '✓' : ''}</span>` +
          `<span class="brief-task-text">${renderInline(tm[2])}</span>` +
        `</li>`,
      )
      continue
    }

    const bm = trimmed.match(/^[-*]\s+(.+)$/)
    if (bm) {
      if (listType !== 'ul') { closeList(); out.push('<ul class="brief-bullet-list">'); listType = 'ul' }
      out.push(`<li>${renderInline(bm[1])}</li>`)
      continue
    }

    if (!trimmed) { closeList(); continue }

    closeList()
    out.push(`<p>${renderInline(trimmed)}</p>`)
  }

  closeList()
  return out.join('\n')
}
