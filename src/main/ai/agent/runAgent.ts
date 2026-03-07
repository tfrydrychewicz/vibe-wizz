/**
 * Top-level agent entry point.
 *
 * Orchestrates the full lifecycle: classify → plan → execute.
 * Pushes progress events at each phase so the renderer can show
 * real-time status from the moment the agent kicks in.
 *
 * For simple prompts (no image generation needed), falls through
 * directly to sendChatMessage with zero overhead beyond the classifier call.
 */

import Database from 'better-sqlite3'
import { needsAgentPlanning, planPrompt } from './planner'
import { executeAgentPlan } from './executor'
import { sendChatMessage } from '../../embedding/chat'
import { pushToRenderer } from '../../push'
import type { AgentContext, AgentResult, AgentPlan } from './types'

/**
 * Push an agent lifecycle phase event to the renderer.
 * These are distinct from step-level progress events — they cover
 * the classify / plan / execute phases of runAgent itself.
 */
function pushPhase(phase: 'classifying' | 'planning' | 'executing' | 'done', stepCount?: number): void {
  pushToRenderer('agent:phase', { phase, stepCount })
}

/** Delegate to sendChatMessage and wrap in AgentResult shape. */
async function delegateToChat(context: AgentContext): Promise<AgentResult> {
  const result = await sendChatMessage(
    context.messages,
    context.contextNotes,
    context.calendarEvents,
    context.actionItems,
    context.images,
    context.files,
    context.entityContext,
    context.pinnedNotes,
    context.richEntities,
    context.entityLinkedNotes,
    context.useWebSearch,
    context.overrideModelId,
    context.noteSelections,
  )
  return {
    content: result.content,
    actions: result.actions,
    entityRefs: result.entityRefs,
    generatedImages: [],
    fallbackWarning: result.fallbackWarning,
  }
}

/**
 * Run the agent on a user prompt.
 *
 * 1. Classify: does the prompt need image generation? (fast LLM call)
 * 2. If no → delegate directly to sendChatMessage (existing path, no overhead)
 * 3. If yes → plan the prompt into steps → execute the plan
 *
 * Returns an AgentResult that is a superset of the sendChatMessage response.
 */
export async function runAgent(
  context: AgentContext,
  db: Database.Database,
): Promise<AgentResult> {
  const lastUserMsg = [...context.messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  // Step 1: Classify — skip planning for simple prompts
  pushPhase('classifying')
  const needsPlanning = await needsAgentPlanning(lastUserMsg, db)
  console.log(`[agent] needsPlanning=${needsPlanning} for prompt: "${lastUserMsg.slice(0, 80)}"`)

  if (!needsPlanning) {
    pushPhase('done')
    return delegateToChat(context)
  }

  // Step 2: Plan — decompose the prompt into typed steps
  pushPhase('planning')

  let plan: AgentPlan
  try {
    plan = await planPrompt(lastUserMsg, db)
  } catch (err) {
    console.warn('[agent] Planning failed, falling back to sendChatMessage:', err)
    pushPhase('done')
    return delegateToChat(context)
  }

  console.log(`[agent] Plan: ${plan.steps.length} steps, singleStepPassthrough=${plan.singleStepPassthrough}`,
    plan.steps.map((s) => `${s.id}:${s.type}`))

  // Step 2b: Single-step passthrough — the planner determined no multi-step needed
  if (plan.singleStepPassthrough) {
    pushPhase('done')
    return delegateToChat(context)
  }

  // Step 3: Execute the multi-step plan
  pushPhase('executing', plan.steps.length)
  const result = await executeAgentPlan(plan, context, db)
  pushPhase('done')
  return result
}
