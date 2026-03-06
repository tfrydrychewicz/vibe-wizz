/**
 * Entity Review Generator.
 *
 * Assembles context for a single entity (notes, action items, calendar events,
 * entity fields) and calls the configured AI model to produce a structured
 * Markdown review covering a rolling time window.
 *
 * Routes through the model router — uses the 'entity_review' feature slot.
 * Defaults to Claude Haiku so it can run in batch for many entities efficiently.
 */

import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { callWithFallback } from '../ai/modelRouter'

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EntityReview {
  id: string
  entity_id: string
  period_start: string   // YYYY-MM-DD
  period_end: string     // YYYY-MM-DD
  content: string        // Markdown
  generated_at: string   // ISO 8601
  model_id: string | null
  acknowledged_at: string | null
}

export interface EntityTypeWithReview {
  id: string
  name: string
  icon: string
  schema: string         // JSON field definitions
  color: string | null
  review_enabled: number
  review_frequency: string | null  // 'daily'|'weekly'|'biweekly'|'monthly'
  review_day: string | null        // 'mon'…'sun'
  review_time: string              // HH:MM
}

interface EntityRow {
  id: string
  name: string
  type_id: string
  fields: string  // JSON
}

interface NoteRow {
  id: string
  title: string
  body_plain: string
  updated_at: string
}

interface ActionRow {
  id: string
  title: string
  status: string
  due_date: string | null
  completed_at: string | null
  project_entity_id: string | null
  project_name: string | null
  is_waiting_for: number
}

interface CalendarRow {
  id: number
  title: string
  start_at: string
  linked_note_id: string | null
  linked_note_title: string | null
}

interface FieldSchema {
  fields?: { name: string; type: string; label?: string }[]
}

// ── Period window helpers ──────────────────────────────────────────────────────

function localDateString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Returns { periodStart, periodEnd } (both YYYY-MM-DD, local time) for the
 * given review frequency. Period always ends yesterday.
 */
export function getPeriodWindow(frequency: string): { periodStart: string; periodEnd: string } {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const lookbackDays =
    frequency === 'daily'     ? 1
    : frequency === 'weekly'  ? 7
    : frequency === 'biweekly'? 14
    : /* monthly */             30

  const start = new Date(yesterday)
  start.setDate(start.getDate() - (lookbackDays - 1))

  return { periodStart: localDateString(start), periodEnd: localDateString(yesterday) }
}

// ── Context builder ────────────────────────────────────────────────────────────

interface EntityContext {
  entityName: string
  typeName: string
  fieldsText: string
  noteLines: string
  openActionsLines: string
  completedActionsLines: string
  waitingActionsLines: string
  calendarLines: string
  noteCount: number
  /** All entity refs (id + name) that appeared in the context — used to post-process the AI output */
  entityRefs: { id: string; name: string }[]
}

export function buildEntityContext(
  db: Database.Database,
  entity: EntityRow,
  type: EntityTypeWithReview,
  periodStart: string,
  periodEnd: string,
): EntityContext {
  const periodStartTs = `${periodStart}T00:00:00`
  const periodEndTs   = `${periodEnd}T23:59:59`

  // ── Entity fields ────────────────────────────────────────────────────────────
  let fieldsText = ''
  try {
    const schema: FieldSchema = JSON.parse(type.schema)
    const entityFields = JSON.parse(entity.fields) as Record<string, unknown>
    const lines: string[] = []
    for (const fieldDef of schema.fields ?? []) {
      const val = entityFields[fieldDef.name]
      if (val === undefined || val === null || val === '') continue
      const label = fieldDef.label ?? fieldDef.name
      lines.push(`${label}: ${String(val)}`)
    }
    fieldsText = lines.length > 0 ? lines.join('\n') : '(no fields set)'
  } catch {
    fieldsText = '(field data unavailable)'
  }

  // ── Notes mentioning this entity in the period ───────────────────────────────
  const notes = db
    .prepare(
      `SELECT DISTINCT n.id, n.title, n.body_plain, n.updated_at
       FROM notes n
       JOIN entity_mentions em ON em.note_id = n.id
       WHERE em.entity_id = ?
         AND n.archived_at IS NULL
         AND n.updated_at >= ? AND n.updated_at <= ?
       ORDER BY n.updated_at DESC
       LIMIT 20`,
    )
    .all(entity.id, periodStartTs, periodEndTs) as NoteRow[]

  const noteLines =
    notes.length > 0
      ? notes
          .map((n) => {
            const excerpt = n.body_plain.length > 600 ? n.body_plain.slice(0, 600) + '…' : n.body_plain
            // Embed note ID as a WIZZ token so the renderer can make it clickable
            return `### {{note:${n.id}:${n.title}}} (${n.updated_at.slice(0, 10)})\n${excerpt || '(empty note)'}`
          })
          .join('\n\n')
      : '(no notes in this period)'

  // ── Action items ─────────────────────────────────────────────────────────────
  const allActions = db
    .prepare(
      `SELECT ai.id, ai.title, ai.status, ai.due_date, ai.completed_at,
              ai.project_entity_id, pe.name AS project_name,
              ai.is_waiting_for
       FROM action_items ai
       LEFT JOIN entities pe ON pe.id = ai.project_entity_id AND pe.trashed_at IS NULL
       WHERE (ai.assigned_entity_id = ? OR ai.waiting_for_entity_id = ?)
         AND ai.status != 'cancelled'
       ORDER BY
         CASE ai.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
         ai.due_date ASC NULLS LAST,
         ai.created_at ASC`,
    )
    .all(entity.id, entity.id) as ActionRow[]

  function fmtAction(a: ActionRow): string {
    let s = `- ${a.title}`
    if (a.project_entity_id && a.project_name) {
      s += ` [project: {{entity:${a.project_entity_id}:${a.project_name}}}]`
    } else if (a.project_name) {
      s += ` [project: ${a.project_name}]`
    }
    if (a.due_date) s += ` [due: ${a.due_date}]`
    return s
  }

  const openActions = allActions.filter((a) => a.status === 'open' || a.status === 'in_progress')
  const completedInPeriod = allActions.filter(
    (a) =>
      a.status === 'done' &&
      a.completed_at &&
      a.completed_at >= periodStartTs &&
      a.completed_at <= periodEndTs,
  )
  const waitingFor = allActions.filter((a) => a.is_waiting_for === 1)

  const openActionsLines      = openActions.length > 0 ? openActions.map(fmtAction).join('\n') : '(none)'
  const completedActionsLines = completedInPeriod.length > 0 ? completedInPeriod.map(fmtAction).join('\n') : '(none)'
  const waitingActionsLines   = waitingFor.length > 0 ? waitingFor.map(fmtAction).join('\n') : '(none)'

  // ── Collect unique entity refs for post-processing ───────────────────────────
  // Seed with project entities from action items (always have IDs).
  const entityRefMap = new Map<string, string>()
  for (const a of allActions) {
    if (a.project_entity_id && a.project_name) {
      entityRefMap.set(a.project_entity_id, a.project_name)
    }
  }

  // Also collect every entity co-mentioned in the same notes as the reviewed
  // entity. These are the people/projects the AI will write about by name (e.g.
  // "Maciej Arciuch", "Sathish Subramanian") but without @-prefixes, so the
  // @Name regex fallback never fires. Injecting their tokens deterministically
  // ensures they render as clickable chips regardless of what the AI writes.
  if (notes.length > 0) {
    const noteIds = notes.map(() => '?').join(',')
    const coMentioned = db
      .prepare(
        `SELECT DISTINCT e.id, e.name
         FROM entity_mentions em
         JOIN entities e ON e.id = em.entity_id
         WHERE em.note_id IN (${noteIds})
           AND e.id != ?
           AND e.trashed_at IS NULL
           AND LENGTH(e.name) > 2`,
      )
      .all(...notes.map((n) => n.id), entity.id) as { id: string; name: string }[]

    for (const e of coMentioned) {
      entityRefMap.set(e.id, e.name)
    }
  }

  const entityRefs = [...entityRefMap.entries()].map(([id, name]) => ({ id, name }))

  // ── Calendar events ───────────────────────────────────────────────────────────
  // Find this entity's email (if attendee mapping is configured) to match against events
  let calendarLines = '(none)'
  try {
    const emailFieldSetting = db
      .prepare("SELECT value FROM settings WHERE key = 'attendee_email_field'")
      .get() as { value: string } | undefined
    const attendeeTypeSetting = db
      .prepare("SELECT value FROM settings WHERE key = 'attendee_entity_type_id'")
      .get() as { value: string } | undefined

    const emailField = emailFieldSetting?.value?.trim() ?? ''
    const attendeeTypeId = attendeeTypeSetting?.value?.trim() ?? ''

    if (emailField && attendeeTypeId && entity.type_id === attendeeTypeId) {
      const entityFields = JSON.parse(entity.fields) as Record<string, unknown>
      const email = typeof entityFields[emailField] === 'string' ? (entityFields[emailField] as string).trim() : ''

      if (email) {
        const events = db
          .prepare(
            `SELECT ce.id, ce.title, ce.start_at, ce.linked_note_id, n.title AS linked_note_title
             FROM calendar_events ce
             LEFT JOIN notes n ON n.id = ce.linked_note_id AND n.archived_at IS NULL
             WHERE ce.start_at >= ? AND ce.start_at <= ?
               AND ce.attendees LIKE ?
             ORDER BY ce.start_at ASC
             LIMIT 20`,
          )
          .all(periodStartTs, periodEndTs, `%${email}%`) as CalendarRow[]

        if (events.length > 0) {
          calendarLines = events
            .map((ev) => {
              const date = ev.start_at.slice(0, 10)
              let line = `- ${date}: ${ev.title}`
              if (ev.linked_note_title) line += ` [notes: "${ev.linked_note_title}"]`
              return line
            })
            .join('\n')
        }
      }
    }
  } catch {
    // Non-critical — skip calendar events if something goes wrong
  }

  return {
    entityName: entity.name,
    typeName: type.name,
    fieldsText,
    noteLines,
    noteCount: notes.length,
    openActionsLines,
    completedActionsLines,
    waitingActionsLines,
    calendarLines,
    entityRefs,
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPrompt(ctx: EntityContext, periodStart: string, periodEnd: string): string {
  const typeGuidance: Record<string, string> = {
    person:   'focus on relationship, collaboration, commitments made and received, open follow-ups, and any patterns worth noting',
    project:  'focus on progress, blockers, decisions made, open tasks, and upcoming milestones',
    team:     'focus on team-wide activity, decisions, workload distribution, and upcoming deadlines',
    decision: 'focus on the rationale recorded, implications discussed, and action items triggered',
    okr:      'focus on progress against key results, risks, and blockers',
  }
  const lowerType = ctx.typeName.toLowerCase()
  const guidance = typeGuidance[lowerType] ?? `summarise activity relevant to a ${ctx.typeName}`

  return (
    `You are a personal knowledge assistant. Generate a concise, structured review.\n\n` +
    `Entity type: "${ctx.typeName}" — ${guidance}.\n\n` +
    `Review period: ${periodStart} to ${periodEnd}.\n\n` +

    `## Entity: ${ctx.entityName} (type: ${ctx.typeName})\n` +
    `${ctx.fieldsText}\n\n` +

    `## Recent Notes (${ctx.noteCount} note${ctx.noteCount === 1 ? '' : 's'} in this period)\n` +
    `${ctx.noteLines}\n\n` +

    `## Action Items\n` +
    `Open:\n${ctx.openActionsLines}\n\n` +
    `Completed this period:\n${ctx.completedActionsLines}\n\n` +
    `Waiting for this entity:\n${ctx.waitingActionsLines}\n\n` +

    `## Calendar Events (this period)\n` +
    `${ctx.calendarLines}\n\n` +

    `---\n\n` +
    `Write a structured Markdown review using the sections below. ` +
    `Omit any section that has no relevant content. ` +
    `Do not hallucinate details not present above.\n\n` +
    `- **Summary** — 2–3 sentence executive summary tailored to the entity type\n` +
    `- **Key discussions** — bullet points from notes; call out decisions or outcomes\n` +
    `- **Open tasks** — open action items; flag any overdue items\n` +
    `- **Completed** — tasks finished in this period\n` +
    `- **Upcoming** — events or deadlines in the near future\n` +
    `- **Follow-ups** — items that may need attention\n\n` +
    `IMPORTANT: When citing a specific note inline, copy its token verbatim from the note header above ` +
    `(e.g. \`{{note:uuid-here:Note Title}}\`). This makes the reference clickable in the UI. ` +
    `Do not alter the UUID or title inside the token.\n\n` +
    `Write only the Markdown content. No preamble or meta-commentary.`
  )
}

// ── Post-processor: inject entity tokens into AI output ────────────────────────

/**
 * Replaces plain entity names in AI-generated content with {{entity:uuid:Name}}
 * tokens so the renderer can make them clickable.
 *
 * The AI (especially smaller models like Haiku) often strips the token format
 * from the context and writes plain names instead. This function re-injects
 * the tokens deterministically based on the entities we know were in the context.
 *
 * Strategy:
 *   1. Split content on existing tokens (preserve them verbatim).
 *   2. In non-token segments only, replace entity names with tokens.
 *   3. Sort refs by name length (longest first) to avoid prefix shadowing.
 */
function injectEntityTokens(
  content: string,
  refs: { id: string; name: string }[],
): string {
  if (refs.length === 0) return content

  // Match existing {{entity:...}} or {{note:...}} tokens to avoid double-wrapping
  const TOKEN_RE = /\{\{(?:entity|note):[0-9a-f-]{36}:[^}]*\}\}/g

  // Split into [non-token, token, non-token, token, ...] segments
  const parts: { text: string; isToken: boolean }[] = []
  let lastIdx = 0
  for (const m of content.matchAll(TOKEN_RE)) {
    const start = m.index!
    if (start > lastIdx) parts.push({ text: content.slice(lastIdx, start), isToken: false })
    parts.push({ text: m[0], isToken: true })
    lastIdx = start + m[0].length
  }
  if (lastIdx < content.length) parts.push({ text: content.slice(lastIdx), isToken: false })

  // Sort longest names first to avoid shorter names shadowing longer ones
  const sorted = [...refs].sort((a, b) => b.name.length - a.name.length)

  return parts
    .map((part) => {
      if (part.isToken) return part.text
      let text = part.text
      for (const ref of sorted) {
        const escaped = ref.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        text = text.replace(
          new RegExp(`\\b${escaped}\\b`, 'g'),
          `{{entity:${ref.id}:${ref.name}}}`,
        )
      }
      return text
    })
    .join('')
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Generate an entity review for the given entity + type, persist it to the DB,
 * and return the stored row.
 *
 * Returns `{ error: string }` if no AI model is configured for the slot.
 * Throws on unexpected DB or network errors (caller should catch + log).
 */
export async function generateEntityReview(
  db: Database.Database,
  entity: EntityRow,
  type: EntityTypeWithReview,
): Promise<EntityReview | { error: string }> {
  const frequency = type.review_frequency ?? 'weekly'
  const { periodStart, periodEnd } = getPeriodWindow(frequency)

  const ctx = buildEntityContext(db, entity, type, periodStart, periodEnd)
  const prompt = buildPrompt(ctx, periodStart, periodEnd)

  let usedModelId: string | null = null
  let content: string

  try {
    content = await callWithFallback('entity_review', db, async (model) => {
      usedModelId = model.modelId
      const result = await model.adapter.chat(
        {
          model: model.modelId,
          maxTokens: 1200,
          messages: [{ role: 'user', content: prompt }],
        },
        model.apiKey,
      )
      return result.text.trim()
    })
    // Deterministically re-inject entity tokens the AI may have stripped
    content = injectEntityTokens(content, ctx.entityRefs)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    // Distinguish "no model configured" from other failures
    if (msg.includes('No AI models configured')) {
      return { error: 'No model configured for the Entity Review feature slot. Open Settings → AI Features to configure one.' }
    }
    throw err
  }

  const id = randomUUID()
  const generatedAt = new Date().toISOString()

  db.prepare(
    `INSERT INTO entity_reviews (id, entity_id, period_start, period_end, content, generated_at, model_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, entity.id, periodStart, periodEnd, content, generatedAt, usedModelId)

  return {
    id,
    entity_id: entity.id,
    period_start: periodStart,
    period_end: periodEnd,
    content,
    generated_at: generatedAt,
    model_id: usedModelId,
    acknowledged_at: null,
  }
}
