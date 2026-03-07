/**
 * Types for the agentic AI workflow orchestrator.
 *
 * The agent decomposes a user prompt into a Plan (ordered steps) and executes
 * each step using the appropriate model capability (chat, image generation,
 * tool calling). Results flow between steps via {{step_N}} placeholders.
 */

import type {
  CalendarEventContext,
  ActionItemContext,
  EntityContext,
  EntityLinkedNote,
  RichEntityContext,
  AttachedFilePayload,
  ExecutedAction,
  NoteSelectionAttachment,
} from '../../embedding/chat'

// ── Step types ────────────────────────────────────────────────────────────────

export type StepType = 'text_generation' | 'image_generation' | 'tool_call'

export interface AgentStep {
  id: number
  type: StepType
  /** Short, human-readable description of what this step does (e.g. "List of Asimov novels"). */
  label: string
  /** The prompt/instruction for this step. May contain {{step_N}} placeholders. */
  prompt: string
  /** IDs of steps whose output this step depends on. Empty = no dependencies. */
  depends_on: number[]
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export interface AgentPlan {
  steps: AgentStep[]
  /**
   * True when the planner determined the request can be handled by a single
   * tool_call step (the common case). The executor can short-circuit and
   * delegate directly to the existing sendChatMessage path.
   */
  singleStepPassthrough: boolean
}

// ── Step results ──────────────────────────────────────────────────────────────

export interface TextStepResult {
  type: 'text_generation'
  text: string
}

export interface ImageStepResult {
  type: 'image_generation'
  /** Absolute path to the saved image file on disk */
  filePath: string
  /** The prompt used (may differ from the original if revised by the model) */
  prompt: string
}

export interface ToolCallStepResult {
  type: 'tool_call'
  /** Final text response from the LLM after tool execution */
  text: string
  actions: ExecutedAction[]
  entityRefs: { id: string; name: string }[]
}

export type StepResult = TextStepResult | ImageStepResult | ToolCallStepResult

// ── Step progress (push event) ────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'complete' | 'error'

export interface StepProgress {
  stepId: number
  type: StepType
  status: StepStatus
  label: string
  /** Present during retries, e.g. "Retry 1/2" */
  retryInfo?: string
}

// ── Agent context (mirrors sendChatMessage params) ────────────────────────────

export interface AgentContext {
  messages: { role: 'user' | 'assistant'; content: string }[]
  contextNotes: { id: string; title: string; excerpt: string }[]
  calendarEvents: CalendarEventContext[]
  actionItems: ActionItemContext[]
  images?: { dataUrl: string; mimeType: string }[]
  files?: AttachedFilePayload[]
  entityContext: EntityContext[]
  pinnedNotes: EntityLinkedNote[]
  richEntities: RichEntityContext[]
  entityLinkedNotes: EntityLinkedNote[]
  useWebSearch: boolean
  overrideModelId?: string
  noteSelections: NoteSelectionAttachment[]
  /** When true, the local free web_search WIZZ_TOOL is exposed to the model. */
  localWebSearchEnabled?: boolean
}

// ── Agent result ──────────────────────────────────────────────────────────────

export interface GeneratedImage {
  /** Absolute file path on disk */
  path: string
  /** The prompt that produced this image */
  prompt: string
}

export interface AgentResult {
  content: string
  actions: ExecutedAction[]
  entityRefs: { id: string; name: string }[]
  generatedImages: GeneratedImage[]
  fallbackWarning?: string
}
