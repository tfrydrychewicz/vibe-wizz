/**
 * Daily Brief generator.
 *
 * Gathers today's calendar events, open action items, and recent notes,
 * then calls Claude Sonnet to produce a structured daily briefing in Markdown.
 * The result is persisted in the `daily_briefs` table.
 */

import Anthropic from '@anthropic-ai/sdk'
import { getDatabase } from '../db/index'

const MODEL = 'claude-sonnet-4-6'
const MAX_NOTES_CHARS = 5000

type CalendarRow = {
  id: number
  title: string
  start_at: string
  end_at: string
  attendees: string
  linked_note_title: string | null
}

type ActionRow = {
  id: string
  title: string
  status: string
  due_date: string | null
  assigned_entity_name: string | null
  source_note_title: string | null
}

type RecentNote = {
  id: string
  title: string
  body_plain: string
  updated_at: string
}

type HistoricalNote = {
  title: string
  body_plain: string
  updated_at: string
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en', { hour: 'numeric', minute: '2-digit' })
}

/**
 * Generate a Daily Brief markdown string for the given ISO date (YYYY-MM-DD).
 * Returns an empty string if the API key is missing or Claude fails.
 */
export async function generateDailyBrief(date: string, apiKey: string): Promise<string> {
  if (!apiKey) return ''

  const db = getDatabase()
  const client = new Anthropic({ apiKey })

  // ── Calendar events for today ────────────────────────────────────────────────
  const dayStart = `${date}T00:00:00`
  const dayEnd = `${date}T23:59:59`
  const todayEvents = db
    .prepare(
      `SELECT ce.id, ce.title, ce.start_at, ce.end_at, ce.attendees,
              n.title AS linked_note_title
       FROM calendar_events ce
       LEFT JOIN notes n ON n.id = ce.linked_note_id AND n.archived_at IS NULL
       WHERE ce.start_at >= ? AND ce.start_at <= ?
       ORDER BY ce.start_at ASC`,
    )
    .all(dayStart, dayEnd) as CalendarRow[]

  // ── Action items (open + in_progress), ordered by urgency ───────────────────
  const actionItems = db
    .prepare(
      `SELECT ai.id, ai.title, ai.status, ai.due_date, ai.created_at,
              e.name AS assigned_entity_name, n.title AS source_note_title
       FROM action_items ai
       LEFT JOIN entities e ON e.id = ai.assigned_entity_id AND e.trashed_at IS NULL
       LEFT JOIN notes n ON n.id = ai.source_note_id AND n.archived_at IS NULL
       WHERE ai.status IN ('open', 'in_progress')
       ORDER BY
         CASE WHEN ai.due_date IS NOT NULL AND ai.due_date < date('now') THEN 0 ELSE 1 END,
         CASE WHEN ai.due_date = date('now') THEN 0 ELSE 1 END,
         ai.due_date ASC NULLS LAST,
         ai.created_at ASC`,
    )
    .all() as ActionRow[]

  // ── Notes updated in the last 2 days ────────────────────────────────────────
  const recentNotes = db
    .prepare(
      `SELECT id, title, body_plain, updated_at FROM notes
       WHERE archived_at IS NULL AND length(body_plain) > 0
         AND updated_at >= datetime('now', '-2 days')
       ORDER BY updated_at DESC
       LIMIT 10`,
    )
    .all() as RecentNote[]

  // ── Historical context for 1:1 meetings today ────────────────────────────────
  const historicalContext: string[] = []
  for (const event of todayEvents) {
    let attendees: { name?: string; email?: string }[] = []
    try { attendees = JSON.parse(event.attendees) as { name?: string; email?: string }[] } catch { continue }

    // Consider it a 1:1 if there's exactly 1 attendee or title contains "1:1" / "1-1"
    const is1on1 =
      attendees.length === 1 ||
      (attendees.length === 2 && /1[:\-]1/i.test(event.title))

    if (!is1on1) continue

    const attendeeName = attendees[0]?.name
    if (!attendeeName) continue

    const prevNotes = db
      .prepare(
        `SELECT n.title, n.body_plain, n.updated_at FROM notes n
         JOIN entity_mentions em ON em.note_id = n.id
         JOIN entities e ON e.id = em.entity_id AND e.trashed_at IS NULL
         WHERE e.name LIKE ? AND n.archived_at IS NULL
           AND n.updated_at >= datetime('now', '-45 days')
         ORDER BY n.updated_at DESC
         LIMIT 3`,
      )
      .all(`%${attendeeName}%`) as HistoricalNote[]

    if (prevNotes.length > 0) {
      const lines = prevNotes.map((n) => `  - "${n.title}" (${n.updated_at.slice(0, 10)})`).join('\n')
      historicalContext.push(`Recent notes mentioning ${attendeeName}:\n${lines}`)
    }
  }

  // ── Build context sections ───────────────────────────────────────────────────
  const today = new Date(`${date}T12:00:00`) // noon to avoid DST edge cases
  const dayOfWeek = today.toLocaleDateString('en', { weekday: 'long' })
  const monthDay = today.toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric' })
  const todayStr = `${dayOfWeek}, ${monthDay}`

  // Calendar section
  const calendarLines =
    todayEvents.length > 0
      ? todayEvents
          .map((ev) => {
            let line = `- ${formatTime(ev.start_at)}–${formatTime(ev.end_at)}: ${ev.title}`
            try {
              const att = JSON.parse(ev.attendees) as { name?: string; email?: string }[]
              if (att.length > 0) line += ` (${att.map((a) => a.name || a.email || '?').join(', ')})`
            } catch { /* ignore */ }
            if (ev.linked_note_title) line += ` [notes: "${ev.linked_note_title}"]`
            return line
          })
          .join('\n')
      : 'No meetings scheduled today.'

  // Action items section — categorised by urgency
  const overdueItems = actionItems.filter((a) => a.due_date && a.due_date < date)
  const dueTodayItems = actionItems.filter((a) => a.due_date === date)
  // Due this week (after today but within 7 days)
  const weekEnd = new Date(today)
  weekEnd.setDate(weekEnd.getDate() + 7)
  const weekEndStr = weekEnd.toISOString().slice(0, 10)
  const dueWeekItems = actionItems.filter(
    (a) => a.due_date && a.due_date > date && a.due_date <= weekEndStr,
  )
  const noDueDateItems = actionItems.filter((a) => !a.due_date)

  function fmtAction(a: ActionRow): string {
    let s = `- ${a.title}`
    if (a.assigned_entity_name) s += ` → ${a.assigned_entity_name}`
    if (a.source_note_title) s += ` (from: "${a.source_note_title}")`
    return s
  }

  const actionSections: string[] = []
  if (overdueItems.length > 0) {
    actionSections.push(`OVERDUE:\n${overdueItems.map((a) => fmtAction(a) + ` [due: ${a.due_date}]`).join('\n')}`)
  }
  if (dueTodayItems.length > 0) {
    actionSections.push(`DUE TODAY:\n${dueTodayItems.map(fmtAction).join('\n')}`)
  }
  if (dueWeekItems.length > 0) {
    actionSections.push(`DUE THIS WEEK:\n${dueWeekItems.map((a) => fmtAction(a) + ` [due: ${a.due_date}]`).join('\n')}`)
  }
  if (noDueDateItems.length > 0) {
    const shown = noDueDateItems.slice(0, 8)
    actionSections.push(`NO DUE DATE (oldest first):\n${shown.map(fmtAction).join('\n')}`)
  }
  const actionLines = actionSections.length > 0 ? actionSections.join('\n\n') : 'No open action items.'

  // Recent notes section — truncated to stay within context budget
  let notesLines = ''
  if (recentNotes.length > 0) {
    let total = 0
    const parts: string[] = []
    for (const note of recentNotes) {
      const excerpt = note.body_plain.length > 600 ? note.body_plain.slice(0, 600) + '…' : note.body_plain
      const block = `"${note.title}" (${note.updated_at.slice(0, 10)}):\n${excerpt}`
      if (total + block.length > MAX_NOTES_CHARS) break
      parts.push(block)
      total += block.length
    }
    notesLines = parts.join('\n\n---\n\n')
  }

  const histLines = historicalContext.join('\n\n')

  // ── Prompt ───────────────────────────────────────────────────────────────────
  const prompt =
    `You are generating a Daily Brief for an engineering manager. Today is ${todayStr}.\n\n` +
    `Generate a concise, actionable daily brief in Markdown. Follow this structure (skip any section that has no relevant content):\n\n` +
    `# ${todayStr} — Your Day\n\n` +
    `## 🔥 Needs Attention\n` +
    `(overdue action items and anything urgent; omit section if nothing is overdue or urgent)\n\n` +
    `## 📅 Today's Meetings\n` +
    `(list each meeting with time; for 1:1s include relevant context from historical notes; omit if no meetings)\n\n` +
    `## ✅ Open Action Items\n` +
    `(use - [ ] checkbox syntax for every item so they render as interactive checkboxes; ` +
    `prioritise overdue → due today → due this week → no due date; cap at ~12 most important items; ` +
    `omit section if no open action items)\n\n` +
    `## 💡 Worth Revisiting\n` +
    `(surface insights or connections from recent notes that are relevant today; omit if nothing notable)\n\n` +
    `---\n\n` +
    `DATA:\n\n` +
    `CALENDAR:\n${calendarLines}\n\n` +
    `ACTION ITEMS:\n${actionLines}\n\n` +
    (notesLines ? `RECENT NOTES (last 2 days):\n${notesLines}\n\n` : '') +
    (histLines ? `HISTORICAL CONTEXT FOR 1:1s:\n${histLines}\n\n` : '') +
    `INSTRUCTIONS:\n` +
    `- Be specific — use real names, titles, and due dates from the data above.\n` +
    `- Flag overdue items prominently in "Needs Attention".\n` +
    `- For 1:1 meetings, mention topics from the historical notes when available.\n` +
    `- Use - [ ] checkbox syntax for every action item line (not - or *).\n` +
    `- Keep the brief concise (aim for 300–600 words total).\n` +
    `- Write only the markdown content, no preamble or meta-commentary.`

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
    const block = response.content[0]
    return block.type === 'text' ? block.text.trim() : ''
  } catch (err) {
    console.error('[DailyBrief] Generation failed:', err)
    return ''
  }
}
