/**
 * Ollama local provider adapter.
 *
 * Communicates with a locally-running Ollama instance over its OpenAI-compatible
 * /v1/ API. The `apiKey` parameter carries the Ollama base URL
 * (e.g. "http://localhost:11434") — Ollama requires no real authentication.
 *
 * Phase 1: chat only. Embedding support is deferred because Ollama embedding
 * models produce dimensions other than the 1536 hardcoded in the sqlite-vec tables.
 */

import OpenAI from 'openai'
import type {
  ProviderAdapter,
  ModelDef,
  ChatParams,
  ChatResult,
  ContentBlock,
  ToolCall,
} from './types'

/** Intentionally empty — models are always discovered live via fetchModels. */
export const OLLAMA_POPULAR_MODELS: ModelDef[] = []

/** Normalize a base URL: strip trailing slash. */
function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') || 'http://localhost:11434'
}

export const ollamaAdapter: ProviderAdapter = {
  /**
   * List installed Ollama models via GET /api/tags.
   * `apiKey` is actually the base URL (e.g. "http://localhost:11434").
   */
  async fetchModels(baseUrl: string): Promise<ModelDef[]> {
    const base = normalizeBase(baseUrl)
    let res: Response
    try {
      res = await fetch(`${base}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      throw new Error(
        `Cannot connect to Ollama at ${base}. ` +
          'Make sure Ollama is running (run: ollama serve). ' +
          (err instanceof Error ? err.message : String(err)),
      )
    }

    if (!res.ok) {
      throw new Error(
        `Ollama returned HTTP ${res.status} at ${base}/api/tags. ` +
          'Make sure Ollama is running and accessible.',
      )
    }

    const data = (await res.json()) as {
      models?: { name: string; details?: { family?: string } }[]
    }
    const models = data.models ?? []

    if (models.length === 0) {
      throw new Error(
        `Ollama is running at ${base} but has no models installed. ` +
          'Pull a model first (e.g. ollama pull qwen2.5:3b).',
      )
    }

    return models.map((m) => ({
      id: m.name,
      label: m.name,
      // Phase 1: all models reported as chat-only.
      // Embedding support requires variable-dimension vec table redesign.
      capabilities: ['chat'] as ('chat' | 'embedding' | 'image')[],
    }))
  },

  /**
   * Execute a chat completion via Ollama's OpenAI-compatible /v1/chat/completions.
   * `apiKey` is the base URL. The OpenAI SDK accepts a dummy apiKey ('ollama')
   * and a custom baseURL — Ollama ignores the key entirely.
   */
  async chat(params: ChatParams, baseUrl: string): Promise<ChatResult> {
    const base = normalizeBase(baseUrl)
    // The OpenAI SDK requires a non-empty apiKey but Ollama ignores it.
    const client = new OpenAI({ baseURL: `${base}/v1`, apiKey: 'ollama' })

    // Build the OpenAI-format message array.
    const messages: OpenAI.ChatCompletionMessageParam[] = []

    if (params.system) {
      messages.push({ role: 'system', content: params.system })
    }

    for (const msg of params.messages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content })
        } else {
          const toolCalls: OpenAI.ChatCompletionMessageToolCall[] = []
          let textContent = ''
          for (const block of msg.content) {
            if (block.type === 'text') textContent += block.text
            else if (block.type === 'tool_call') {
              toolCalls.push({
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) },
              })
            }
          }
          const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
            role: 'assistant',
            ...(textContent ? { content: textContent } : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          }
          messages.push(assistantMsg)
        }
      } else {
        // user turn — text only in Phase 1 (skip image blocks)
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content })
        } else {
          const parts: OpenAI.ChatCompletionContentPart[] = []
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text })
            } else if (block.type === 'tool_result') {
              // Tool results are separate messages in OpenAI's format.
              messages.push({
                role: 'tool',
                tool_call_id: block.toolCallId,
                content: block.content,
              })
            }
            // image blocks: skipped in Phase 1
          }
          if (parts.length > 0) {
            messages.push({ role: 'user', content: parts })
          }
        }
      }
    }

    // Build tool definitions. Ollama uses the same format as OpenAI.
    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    // Ollama uses max_tokens (OpenAI legacy param), not max_completion_tokens.
    const response = await client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    })

    const choice = response.choices[0]
    const rawBlocks: ContentBlock[] = []
    const toolCalls: ToolCall[] = []
    let text = ''

    if (choice.message.content) {
      text = choice.message.content
      rawBlocks.push({ type: 'text', text })
    }

    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== 'function') continue
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(tc.function.arguments)
      } catch {
        /* ignore malformed JSON from models that don't format tool args correctly */
      }
      toolCalls.push({ id: tc.id, name: tc.function.name, input })
      rawBlocks.push({ type: 'tool_call', id: tc.id, name: tc.function.name, input })
    }

    const stopReason =
      choice.finish_reason === 'tool_calls'
        ? 'tool_use'
        : choice.finish_reason === 'length'
          ? 'max_tokens'
          : choice.finish_reason === 'stop'
            ? 'end_turn'
            : 'other'

    return { text, stopReason, toolCalls, rawBlocks }
  },

  // embed() intentionally omitted — Phase 1: chat only.
  // Ollama embedding models produce non-1536 dimensions incompatible with
  // the current sqlite-vec FLOAT[1536] tables. See OLLAMA_LOCAL_PROVIDER.md Phase 2.
}
