/**
 * Task attribute derivation (GTD clarify step).
 *
 * Given a task title and surrounding note context, uses a fast chat model to
 * infer structured GTD attributes: project, assignee, due date, contexts,
 * energy level, and waiting-for. Runs fire-and-forget after task promotion.
 *
 * Routes through the model router — uses the 'task_clarify' feature slot.
 */

import { callWithFallback } from '../ai/modelRouter'
import { getDatabase } from '../db/index'
import { getCurrentDateString } from '../utils/date'

const MAX_CONTEXT_CHARS = 1500

export interface DerivedTaskAttributes {
  project_entity_id: string | null
  project_name: string | null
  assigned_entity_id: string | null
  assigned_entity_name: string | null
  due_date: string | null
  contexts: string[]
  energy_level: 'low' | 'medium' | 'high' | null
  is_waiting_for: boolean
  waiting_for_entity_id: string | null
  waiting_for_entity_name: string | null
  confidence: number
}

/**
 * Derive GTD attributes for a task from its text and surrounding note context.
 * Loads known project entities and persons from the DB to enable ID resolution.
 * Returns DerivedTaskAttributes; confidence = 0 on any failure.
 */
export async function deriveTaskAttributes(
  taskText: string,
  noteContext: string,
  _noteId: string,
): Promise<DerivedTaskAttributes> {
  const empty: DerivedTaskAttributes = {
    project_entity_id: null,
    project_name: null,
    assigned_entity_id: null,
    assigned_entity_name: null,
    due_date: null,
    contexts: [],
    energy_level: null,
    is_waiting_for: false,
    waiting_for_entity_id: null,
    waiting_for_entity_name: null,
    confidence: 0,
  }

  if (!taskText.trim()) return empty

  const db = getDatabase()

  // Load configured GTD project entity type
  const projectTypeRow = db
    .prepare("SELECT value FROM settings WHERE key = 'gtd_project_entity_type_id'")
    .get() as { value: string } | undefined
  const projectTypeId = projectTypeRow?.value?.trim() ?? ''

  // Load project entities (up to 50)
  const projects: { id: string; name: string }[] = projectTypeId
    ? (db
        .prepare(
          `SELECT id, name FROM entities WHERE type_id = ? AND trashed_at IS NULL ORDER BY name LIMIT 50`,
        )
        .all(projectTypeId) as { id: string; name: string }[])
    : []

  // Load person entities (up to 50) for assignee + waiting-for resolution
  const persons: { id: string; name: string }[] = db
    .prepare(
      `SELECT id, name FROM entities WHERE type_id = 'person' AND trashed_at IS NULL ORDER BY name LIMIT 50`,
    )
    .all() as { id: string; name: string }[]

  const truncatedContext =
    noteContext.length > MAX_CONTEXT_CHARS
      ? noteContext.slice(0, MAX_CONTEXT_CHARS) + '…'
      : noteContext

  const projectList =
    projects.length > 0
      ? projects.map((p) => `  - "${p.name}" (id: ${p.id})`).join('\n')
      : '  (none configured)'

  const personList =
    persons.length > 0
      ? persons.map((p) => `  - "${p.name}" (id: ${p.id})`).join('\n')
      : '  (none)'

  return callWithFallback('task_clarify', db, async (model) => {
    const result = await model.adapter.chat(
      {
        model: model.modelId,
        maxTokens: 256,
        messages: [
          {
            role: 'user',
            content:
              `Today is ${getCurrentDateString()}.\n\n` +
              `You are helping organise a task using the GTD methodology. ` +
              `Based on the task text and surrounding note context, infer the structured attributes below.\n\n` +
              `Task: "${taskText}"\n\n` +
              `Note context:\n${truncatedContext}\n\n` +
              `Known projects:\n${projectList}\n\n` +
              `Known people:\n${personList}\n\n` +
              `Respond with ONLY a JSON object with these keys:\n` +
              `- "project_entity_id": id string from known projects, or null\n` +
              `- "assigned_entity_id": id string from known people, or null\n` +
              `- "due_date": ISO 8601 date string (YYYY-MM-DD) if a deadline is mentioned, or null\n` +
              `- "contexts": array of GTD context tags inferred from the task (e.g. ["@computer","@phone"]), empty array if none\n` +
              `- "energy_level": "low", "medium", or "high" based on task complexity, or null if unclear\n` +
              `- "is_waiting_for": true if the task is blocked on another person, false otherwise\n` +
              `- "waiting_for_entity_id": id string from known people if is_waiting_for is true and person is identifiable, else null\n` +
              `- "confidence": float 0.0–1.0 representing overall confidence in the derived attributes\n\n` +
              `Rules:\n` +
              `- Only use IDs that appear in the known projects or known people lists above\n` +
              `- Do not invent IDs or names\n` +
              `- If nothing is clear from context, return nulls/empty arrays with confidence 0.1`,
          },
        ],
      },
      model.apiKey,
    )

    const block = result.rawBlocks.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') return empty

    const text = block.text.trim().replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return empty
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const obj = parsed as Record<string, unknown>

    const projectId = typeof obj['project_entity_id'] === 'string' ? obj['project_entity_id'] : null
    const assigneeId = typeof obj['assigned_entity_id'] === 'string' ? obj['assigned_entity_id'] : null
    const waitingForId = typeof obj['waiting_for_entity_id'] === 'string' ? obj['waiting_for_entity_id'] : null

    // Resolve names — only accept IDs that were actually in the injected lists
    const projectMatch = projects.find((p) => p.id === projectId) ?? null
    const assigneeMatch = persons.find((p) => p.id === assigneeId) ?? null
    const waitingForMatch = persons.find((p) => p.id === waitingForId) ?? null

    return {
      project_entity_id: projectMatch?.id ?? null,
      project_name: projectMatch?.name ?? null,
      assigned_entity_id: assigneeMatch?.id ?? null,
      assigned_entity_name: assigneeMatch?.name ?? null,
      due_date: typeof obj['due_date'] === 'string' ? obj['due_date'] : null,
      contexts: Array.isArray(obj['contexts'])
        ? (obj['contexts'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : [],
      energy_level: (['low', 'medium', 'high'] as const).find((v) => v === obj['energy_level']) ?? null,
      is_waiting_for: obj['is_waiting_for'] === true,
      waiting_for_entity_id: waitingForMatch?.id ?? null,
      waiting_for_entity_name: waitingForMatch?.name ?? null,
      confidence: typeof obj['confidence'] === 'number' ? Math.min(1, Math.max(0, obj['confidence'])) : 0.5,
    }
  })
}
