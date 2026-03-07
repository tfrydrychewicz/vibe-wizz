/**
 * Agent executor — runs an AgentPlan step by step.
 *
 * Steps are topologically sorted by dependencies. Independent steps (no
 * mutual dependency) run in parallel via Promise.all. Each step's output is
 * stored so later steps can reference it via {{step_N}} placeholders.
 *
 * Step dispatch:
 *   - text_generation  → callWithFallback('chat') for plain text output
 *   - image_generation → callWithFallback('image_generation') → save to disk
 *   - tool_call        → delegates to sendChatMessage (full tool-use loop)
 */

import { basename } from 'path'
import Database from 'better-sqlite3'
import { callWithFallback } from '../modelRouter'
import { saveGeneratedImage } from '../imageStorage'
import { pushToRenderer } from '../../push'
import { sendChatMessage } from '../../embedding/chat'
import type {
  AgentPlan,
  AgentStep,
  AgentContext,
  AgentResult,
  StepResult,
  StepProgress,
  GeneratedImage,
} from './types'
import type { ExecutedAction } from '../../embedding/chat'

// ── Placeholder substitution ──────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{step_(\d+)\}\}/g

function substituteOutputs(
  prompt: string,
  results: Map<number, StepResult>,
): string {
  return prompt.replace(PLACEHOLDER_RE, (_, idStr) => {
    const id = Number(idStr)
    const result = results.get(id)
    if (!result) return `{{step_${id}}}`

    switch (result.type) {
      case 'text_generation':
        return result.text
      case 'image_generation':
        return result.filePath ? `wizz-file://${basename(result.filePath)}` : ''
      case 'tool_call':
        return result.text
    }
  })
}

// ── Topological sort ──────────────────────────────────────────────────────────

/**
 * Returns steps grouped into "layers" — each layer contains steps that can
 * run in parallel (all their dependencies are in earlier layers).
 */
function topologicalLayers(steps: AgentStep[]): AgentStep[][] {
  const stepMap = new Map(steps.map((s) => [s.id, s]))
  const inDegree = new Map<number, number>()
  const adj = new Map<number, number[]>()

  for (const s of steps) {
    inDegree.set(s.id, s.depends_on.length)
    if (!adj.has(s.id)) adj.set(s.id, [])
    for (const dep of s.depends_on) {
      if (!adj.has(dep)) adj.set(dep, [])
      adj.get(dep)!.push(s.id)
    }
  }

  const layers: AgentStep[][] = []
  const remaining = new Set(steps.map((s) => s.id))

  while (remaining.size > 0) {
    const layer: AgentStep[] = []
    for (const id of remaining) {
      if ((inDegree.get(id) ?? 0) <= 0) {
        layer.push(stepMap.get(id)!)
      }
    }
    if (layer.length === 0) {
      throw new Error('Cycle detected in step dependencies')
    }
    for (const s of layer) {
      remaining.delete(s.id)
      for (const neighbor of adj.get(s.id) ?? []) {
        inDegree.set(neighbor, (inDegree.get(neighbor) ?? 1) - 1)
      }
    }
    layers.push(layer)
  }

  return layers
}

// ── Progress reporting ────────────────────────────────────────────────────────

function pushProgress(progress: StepProgress): void {
  pushToRenderer('agent:step-progress', progress)
}

function stepLabel(step: AgentStep): string {
  if (step.label) return step.label
  switch (step.type) {
    case 'text_generation':
      return 'Generating text content'
    case 'image_generation':
      return 'Generating image'
    case 'tool_call':
      return 'Executing tools'
  }
}

// ── Step execution ────────────────────────────────────────────────────────────

const STEP_TIMEOUT_MS: Record<string, number> = {
  text_generation: 30_000,
  image_generation: 60_000,
  tool_call: 60_000,
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Step "${label}" timed out after ${ms / 1000}s`)),
      ms,
    )
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function executeTextGeneration(
  step: AgentStep,
  prompt: string,
  db: Database.Database,
): Promise<StepResult> {
  const text = await callWithFallback('chat', db, async (model) => {
    const result = await model.adapter.chat(
      {
        model: model.modelId,
        system: 'You are a helpful writing assistant. Generate the requested content in well-structured Markdown. Do not include any preamble or explanation — output only the requested content.',
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4000,
      },
      model.apiKey,
    )
    return result.text.trim()
  })

  return { type: 'text_generation', text }
}

const IMAGE_MAX_ATTEMPTS = 3
const IMAGE_RETRY_DELAY_MS = 2000
const IMAGE_CALL_TIMEOUT_MS = 30_000

async function executeImageGeneration(
  step: AgentStep,
  prompt: string,
  db: Database.Database,
): Promise<StepResult> {
  let lastError: unknown

  for (let attempt = 0; attempt < IMAGE_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      const retryInfo = `Retry ${attempt}/${IMAGE_MAX_ATTEMPTS - 1}`
      console.warn(`[agent] Image generation ${retryInfo} in ${IMAGE_RETRY_DELAY_MS}ms`)
      pushProgress({
        stepId: step.id, type: step.type, status: 'running',
        label: stepLabel(step), retryInfo,
      })
      await new Promise((r) => setTimeout(r, IMAGE_RETRY_DELAY_MS))
    }

    try {
      const result = await callWithFallback('image_generation', db, async (model) => {
        if (!model.adapter.generateImage) {
          throw new Error(`Model ${model.modelId} does not support image generation`)
        }
        return withTimeout(
          model.adapter.generateImage({ model: model.modelId, prompt }, model.apiKey),
          IMAGE_CALL_TIMEOUT_MS,
          `${model.modelId} image generation`,
        )
      })

      const filePath = await saveGeneratedImage(result.base64, result.mimeType)
      return {
        type: 'image_generation',
        filePath,
        prompt: result.revisedPrompt ?? prompt,
      }
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[agent] Image generation attempt ${attempt + 1}/${IMAGE_MAX_ATTEMPTS} failed: ${msg}`)
    }
  }

  throw lastError
}

async function executeToolCall(
  step: AgentStep,
  prompt: string,
  context: AgentContext,
  db: Database.Database,
): Promise<StepResult> {
  // Build a single-message conversation with the assembled prompt
  // and delegate to sendChatMessage which handles the full tool-use loop
  const messages = [
    ...context.messages.slice(0, -1),
    { role: 'user' as const, content: prompt },
  ]

  const result = await sendChatMessage(
    messages,
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
    context.localWebSearchEnabled ?? false,
  )

  return {
    type: 'tool_call',
    text: result.content,
    actions: result.actions,
    entityRefs: result.entityRefs,
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Execute an agent plan step by step.
 *
 * Returns the assembled result: final text content, all executed actions,
 * entity refs, and generated images collected across all steps.
 */
export async function executeAgentPlan(
  plan: AgentPlan,
  context: AgentContext,
  db: Database.Database,
): Promise<AgentResult> {
  const layers = topologicalLayers(plan.steps)
  const results = new Map<number, StepResult>()
  const allActions: ExecutedAction[] = []
  const allEntityRefs = new Map<string, { id: string; name: string }>()
  const generatedImages: GeneratedImage[] = []
  const warnings: string[] = []

  // Mark all steps as pending
  for (const step of plan.steps) {
    pushProgress({ stepId: step.id, type: step.type, status: 'pending', label: stepLabel(step) })
  }

  for (const layer of layers) {
    const layerPromises = layer.map(async (step) => {
      const prompt = substituteOutputs(step.prompt, results)
      pushProgress({ stepId: step.id, type: step.type, status: 'running', label: stepLabel(step) })

      try {
        const timeoutMs = STEP_TIMEOUT_MS[step.type] ?? 60_000
        let result: StepResult

        switch (step.type) {
          case 'text_generation':
            result = await withTimeout(
              executeTextGeneration(step, prompt, db),
              timeoutMs,
              stepLabel(step),
            )
            break

          case 'image_generation':
            try {
              result = await executeImageGeneration(step, prompt, db)
            } catch (imgErr) {
              const msg = imgErr instanceof Error ? imgErr.message : String(imgErr)
              console.warn(`[agent] Image generation failed (step ${step.id}): ${msg}`)

              let warning: string
              if (msg.includes('No AI models configured')) {
                warning = 'No image generation model configured. Open **Settings → AI Providers** to add one.'
              } else if (msg.includes('content_policy') || msg.includes('safety') || msg.includes('blocked')) {
                warning = 'Image generation was blocked by the provider\'s content policy. Try rephrasing the description.'
              } else if (msg.includes('rate') || msg.includes('429') || msg.includes('quota')) {
                warning = 'Image generation rate limit reached. Please try again in a moment.'
              } else if (msg.includes('timed out')) {
                warning = 'Image generation timed out. The provider may be experiencing high load.'
              } else {
                warning = `Image generation failed: ${msg}`
              }
              warnings.push(warning)

              result = {
                type: 'image_generation',
                filePath: '',
                prompt,
              }
              results.set(step.id, result)
              pushProgress({ stepId: step.id, type: step.type, status: 'error', label: stepLabel(step) })
              return
            }
            break

          case 'tool_call':
            result = await withTimeout(
              executeToolCall(step, prompt, context, db),
              timeoutMs,
              stepLabel(step),
            )
            break
        }

        results.set(step.id, result)
        pushProgress({ stepId: step.id, type: step.type, status: 'complete', label: stepLabel(step) })

        // Collect outputs
        if (result.type === 'tool_call') {
          allActions.push(...result.actions)
          for (const ref of result.entityRefs) {
            if (!allEntityRefs.has(ref.id)) allEntityRefs.set(ref.id, ref)
          }
        }
        if (result.type === 'image_generation' && result.filePath) {
          const consumedByTool = plan.steps.some(
            (s) => s.type === 'tool_call' && s.depends_on.includes(step.id),
          )
          if (!consumedByTool) {
            generatedImages.push({ path: result.filePath, prompt: result.prompt })
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[agent] Step ${step.id} (${step.type}) failed: ${msg}`)
        pushProgress({ stepId: step.id, type: step.type, status: 'error', label: stepLabel(step) })
        throw err
      }
    })

    await Promise.all(layerPromises)
  }

  // Final text: use the last tool_call step's text, or concatenate text_generation outputs
  let content = ''
  const lastToolCall = [...results.values()]
    .filter((r): r is Extract<StepResult, { type: 'tool_call' }> => r.type === 'tool_call')
    .at(-1)

  if (lastToolCall) {
    content = lastToolCall.text
  } else {
    content = [...results.values()]
      .filter((r): r is Extract<StepResult, { type: 'text_generation' }> => r.type === 'text_generation')
      .map((r) => r.text)
      .join('\n\n')
  }

  if (warnings.length > 0) {
    content += '\n\n' + warnings.map((w) => `⚠️ ${w}`).join('\n')
  }

  return {
    content,
    actions: allActions,
    entityRefs: Array.from(allEntityRefs.values()),
    generatedImages,
    fallbackWarning: warnings.length > 0 ? warnings.join('; ') : undefined,
  }
}
