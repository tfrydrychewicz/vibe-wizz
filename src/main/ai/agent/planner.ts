/**
 * Agent planner — decomposes a user prompt into an ordered plan of typed steps.
 *
 * The planner uses the chat LLM to analyze the request and produce a structured
 * JSON plan. A lightweight AI classifier determines whether planning is needed
 * at all (language-agnostic — works for any language the user writes in).
 */

import Database from 'better-sqlite3'
import { callWithFallback, resolveChain } from '../modelRouter'
import type { AgentPlan, AgentStep, StepType } from './types'

// ── Image classification ──────────────────────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT =
  'You are a binary classifier. The user will send a message. ' +
  'Decide whether fulfilling the request requires GENERATING a new image, picture, illustration, photo, drawing, or any other visual content. ' +
  'Asking ABOUT images, referencing existing images, or attaching images does NOT count — only explicit requests to CREATE/GENERATE new visual content count. ' +
  'Respond with exactly one word: "yes" or "no".'

/**
 * Language-agnostic check: does the prompt require image generation?
 *
 * Uses a fast, cheap LLM call to classify the intent. Returns false for the
 * vast majority of prompts, skipping the full planning step. Also returns
 * false immediately (no LLM call) when no image generation model is configured.
 */
export async function needsAgentPlanning(prompt: string, db: Database.Database): Promise<boolean> {
  const imageChain = resolveChain('image_generation', db)
  console.log(`[agent] needsAgentPlanning — image chain length: ${imageChain.length}`,
    imageChain.map((m) => m.modelId))
  if (imageChain.length === 0) return false

  try {
    const answer = await callWithFallback('chat', db, async (model) => {
      const result = await model.adapter.chat(
        {
          model: model.modelId,
          system: CLASSIFY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 128,
        },
        model.apiKey,
      )
      return result.text.trim().toLowerCase()
    })
    console.log(`[agent] classifier answer: "${answer}"`)
    if (!answer) return false
    return answer.startsWith('yes')
  } catch (err) {
    console.warn('[agent] classifier failed:', err)
    return false
  }
}

// ── Planning prompt ───────────────────────────────────────────────────────────

const PLANNING_SYSTEM_PROMPT = `You are a task planner for Wizz, a knowledge management desktop app. Your job is to analyze the user's request and decompose it into an ordered list of execution steps.

Available step types:
- "text_generation": Generate text content using an LLM. Use for writing, summarizing, listing, drafting.
- "image_generation": Generate an image from a text description. Use ONLY when the user explicitly asks for a picture, illustration, image, photo, drawing, or similar visual content.
- "tool_call": Execute a Wizz tool to create, update, or delete something (notes, calendar events, action items, entities). The tool_call step receives the full conversation context and available tools — write its prompt as a natural-language instruction describing what to create/modify and how to incorporate outputs from earlier steps.

Rules:
1. Each step has: "id" (number, starting at 1), "type", "label" (short ≤6-word description shown to the user), "prompt" (the full instruction), and "depends_on" (array of step IDs whose output this step needs).
2. A step can reference the output of an earlier step using {{step_N}} in its prompt — this will be replaced with the actual result at execution time.
3. For image_generation steps, {{step_N}} is replaced with the LOCAL FILE PATH of the saved image. Use it in markdown image syntax: ![description]({{step_N}})
4. If two steps don't depend on each other, give them independent depends_on arrays so they can run in parallel.
5. The final step MUST be a "tool_call" when the user wants something created or changed in Wizz.
6. For image_generation steps, write a detailed visual description as the prompt — do NOT just repeat the user's words. Describe style, composition, colors, mood.
7. Keep plans minimal — use the fewest steps necessary. Most requests need only 1-3 steps.
8. If the request doesn't need image generation at all, return a single tool_call step.

Respond with ONLY a JSON object (no markdown fences, no explanation):
{"steps": [{"id": 1, "type": "...", "label": "...", "prompt": "...", "depends_on": []}, ...]}

Examples:

User: "Create a note with a list of Shakespeare dramas and a relevant picture in the header"
{"steps": [{"id": 1, "type": "text_generation", "label": "Shakespeare dramas list", "prompt": "Generate a comprehensive markdown list of all Shakespeare dramas (tragedies, comedies, histories) with brief one-line descriptions for each play.", "depends_on": []}, {"id": 2, "type": "image_generation", "label": "Theater stage illustration", "prompt": "A dramatic Renaissance theater stage with rich red velvet curtains, warm candlelight illumination, ornate gilded columns, and a single spotlight on center stage. Oil painting style, classical composition, warm golden tones.", "depends_on": []}, {"id": 3, "type": "tool_call", "label": "Create Shakespeare note", "prompt": "Create a note titled 'Shakespeare Dramas'. Put the image ![Shakespeare theater]({{step_2}}) at the top, then {{step_1}} as the body content.", "depends_on": [1, 2]}]}

User: "Schedule a meeting for Friday at 3pm"
{"steps": [{"id": 1, "type": "tool_call", "label": "Schedule Friday meeting", "prompt": "Schedule a meeting for Friday at 3pm", "depends_on": []}]}

User: "Create a project summary note for Project Alpha with a cover image"
{"steps": [{"id": 1, "type": "text_generation", "label": "Project Alpha summary", "prompt": "Write a professional project summary for Project Alpha covering objectives, current status, key milestones, team members, and next steps. Use markdown formatting with headers and bullet points.", "depends_on": []}, {"id": 2, "type": "image_generation", "label": "Project cover illustration", "prompt": "A modern, clean abstract illustration representing project management and teamwork. Geometric shapes in blue and teal tones forming an upward trajectory, with interconnected nodes suggesting collaboration. Flat design style, professional, minimalist.", "depends_on": []}, {"id": 3, "type": "tool_call", "label": "Create Project Alpha note", "prompt": "Create a note titled 'Project Alpha — Summary'. Put the image ![Project Alpha cover]({{step_2}}) at the top, then {{step_1}} as the body.", "depends_on": [1, 2]}]}`

// ── Plan parsing & validation ─────────────────────────────────────────────────

const VALID_STEP_TYPES: Set<string> = new Set(['text_generation', 'image_generation', 'tool_call'])

function validatePlan(raw: unknown): AgentPlan {
  if (!raw || typeof raw !== 'object') throw new Error('Plan is not an object')

  const obj = raw as Record<string, unknown>
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error('Plan has no steps')
  }

  const steps: AgentStep[] = []
  const ids = new Set<number>()

  for (const s of obj.steps) {
    if (!s || typeof s !== 'object') throw new Error('Step is not an object')
    const step = s as Record<string, unknown>

    const id = Number(step.id)
    if (!Number.isInteger(id) || id < 1) throw new Error(`Invalid step id: ${step.id}`)
    if (ids.has(id)) throw new Error(`Duplicate step id: ${id}`)
    ids.add(id)

    const type = String(step.type)
    if (!VALID_STEP_TYPES.has(type)) throw new Error(`Invalid step type: ${type}`)

    const label = String(step.label ?? '').slice(0, 60) || undefined
    const prompt = String(step.prompt ?? '')
    if (!prompt) throw new Error(`Step ${id} has empty prompt`)

    const depends_on = Array.isArray(step.depends_on)
      ? (step.depends_on as unknown[]).map(Number).filter(Number.isInteger)
      : []

    steps.push({ id, type: type as StepType, label: label ?? '', prompt, depends_on })
  }

  // DAG validation: no step should depend on itself or a non-existent step
  for (const step of steps) {
    for (const dep of step.depends_on) {
      if (dep === step.id) throw new Error(`Step ${step.id} depends on itself`)
      if (!ids.has(dep)) throw new Error(`Step ${step.id} depends on non-existent step ${dep}`)
    }
  }

  // Cycle detection via topological sort (Kahn's algorithm)
  const inDegree = new Map<number, number>()
  const adj = new Map<number, number[]>()
  for (const step of steps) {
    inDegree.set(step.id, 0)
    adj.set(step.id, [])
  }
  for (const step of steps) {
    for (const dep of step.depends_on) {
      adj.get(dep)!.push(step.id)
      inDegree.set(step.id, (inDegree.get(step.id) ?? 0) + 1)
    }
  }
  const queue: number[] = []
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id)
  }
  let visited = 0
  while (queue.length > 0) {
    const node = queue.shift()!
    visited++
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    }
  }
  if (visited !== steps.length) throw new Error('Plan contains a dependency cycle')

  const singleStepPassthrough =
    steps.length === 1 && steps[0].type === 'tool_call'

  return { steps, singleStepPassthrough }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Analyze the user's prompt and produce an execution plan.
 *
 * The last user message is extracted from the messages array and sent to the
 * planner LLM. The planner returns a structured JSON plan.
 */
export async function planPrompt(
  userPrompt: string,
  db: Database.Database,
): Promise<AgentPlan> {
  const plan = await callWithFallback('chat', db, async (model) => {
    const result = await model.adapter.chat(
      {
        model: model.modelId,
        system: PLANNING_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: 1024,
      },
      model.apiKey,
    )

    const text = result.text.trim()

    // Strip markdown code fences if the LLM wrapped its response
    const jsonStr = text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '')

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonStr)
    } catch {
      throw new Error(`Planner returned invalid JSON: ${text.slice(0, 200)}`)
    }

    return validatePlan(parsed)
  })

  return plan
}
