/**
 * Anthropic provider adapter.
 *
 * Wraps @anthropic-ai/sdk to implement the ProviderAdapter interface.
 * Supports chat completions with text, images, and tool use.
 * Web search (ChatParams.webSearch) is handled internally: the adapter loops
 * through server-side web search turns transparently, returning only when a
 * final answer or a client-side tool call is ready.
 * Does NOT implement embed() — Anthropic has no public embeddings endpoint.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  ProviderAdapter,
  ModelDef,
  ChatParams,
  ChatResult,
  ContentBlock,
  ToolCall,
} from './types'

// Server-side web search tool — Anthropic executes this automatically.
// Defined here as a private implementation detail of this adapter.
const WEB_SEARCH_TOOL: Anthropic.Messages.WebSearchTool20260209 = {
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 5,
}

/** Fallback used when no models have been fetched yet. */
export const ANTHROPIC_POPULAR_MODELS: ModelDef[] = [
  { id: 'claude-opus-4-6',           label: 'Claude Opus 4.6',   capabilities: ['chat'] },
  { id: 'claude-sonnet-4-6',         label: 'Claude Sonnet 4.6', capabilities: ['chat'] },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5',  capabilities: ['chat'] },
]

export const anthropicAdapter: ProviderAdapter = {
  async fetchModels(apiKey: string): Promise<ModelDef[]> {
    const client = new Anthropic({ apiKey })
    const response = await client.models.list({ limit: 1000 })

    const models: ModelDef[] = response.data
      .filter((m) => m.id.startsWith('claude-'))
      .map((m) => ({
        id: m.id,
        label: m.display_name ?? m.id,
        // Anthropic currently offers chat only; image/embedding reserved for future
        capabilities: ['chat'] as ('chat' | 'embedding' | 'image')[],
      }))

    return models.length > 0 ? models : ANTHROPIC_POPULAR_MODELS
  },

  async chat(params: ChatParams, apiKey: string): Promise<ChatResult> {
    const client = new Anthropic({ apiKey })

    // Convert normalized messages → Anthropic MessageParam[]
    let anthropicMessages: Anthropic.MessageParam[] = params.messages.map(toAnthropicMessage)

    // Convert normalized ToolDef[] → Anthropic Tool[] + optionally add web search
    const tools: Anthropic.Messages.ToolUnion[] = (params.tools ?? []).map(
      (t): Anthropic.Tool => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
      }),
    )
    if (params.webSearch) {
      tools.push(WEB_SEARCH_TOOL)
    }

    const MAX_INTERNAL_ITERATIONS = 10

    for (let i = 0; i < MAX_INTERNAL_ITERATIONS; i++) {
      const request: Anthropic.MessageCreateParamsNonStreaming = {
        model: params.model,
        max_tokens: params.maxTokens,
        messages: anthropicMessages,
        ...(params.system ? { system: params.system } : {}),
        ...(tools.length > 0 ? { tools } : {}),
      }

      const response = await client.messages.create(request)

      // Client-side tool calls are type === 'tool_use'.
      // Server-side tool calls (web search) are type === 'server_tool_use' — handled internally.
      const clientToolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      )

      if (response.stop_reason !== 'tool_use' || clientToolUses.length > 0) {
        // Final answer or client-side tool calls — translate and return to caller.
        const toolCalls: ToolCall[] = clientToolUses.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: tc.input as Record<string, unknown>,
        }))

        const rawBlocks: ContentBlock[] = []
        let text = ''
        for (const block of response.content) {
          if (block.type === 'text') {
            text += block.text
            rawBlocks.push({ type: 'text', text: block.text })
          } else if (block.type === 'tool_use') {
            rawBlocks.push({ type: 'tool_call', id: block.id, name: block.name, input: block.input as Record<string, unknown> })
          }
          // server_tool_use and web_search_tool_result are internal — not exposed to caller
        }

        const stopReason =
          response.stop_reason === 'tool_use' ? 'tool_use'
          : response.stop_reason === 'max_tokens' ? 'max_tokens'
          : response.stop_reason === 'end_turn' ? 'end_turn'
          : 'other'

        return { text, stopReason, toolCalls, rawBlocks }
      }

      // Only server-side tools (web search) — loop internally.
      // Anthropic embeds search results directly in the assistant content; no user turn needed.
      anthropicMessages = [...anthropicMessages, { role: 'assistant', content: response.content }]
    }

    // Fallback if max internal iterations reached
    return { text: '', stopReason: 'other', toolCalls: [], rawBlocks: [] }
  },
  // No embed() — Anthropic does not offer an embeddings API
}

/** Convert a normalized ChatMessage to an Anthropic MessageParam. */
function toAnthropicMessage(msg: { role: 'user' | 'assistant'; content: string | ContentBlock[] }): Anthropic.MessageParam {
  if (typeof msg.content === 'string') {
    return { role: msg.role, content: msg.content }
  }

  const parts: Anthropic.ContentBlockParam[] = []
  for (const block of msg.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push({
        type: 'image',
        source: { type: 'base64', media_type: block.mediaType, data: block.data },
      })
    } else if (block.type === 'tool_call') {
      parts.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
    } else if (block.type === 'tool_result') {
      parts.push({
        type: 'tool_result',
        tool_use_id: block.toolCallId,
        content: block.content,
        is_error: block.isError,
      })
    }
    // Other block types (e.g. from other providers) are silently skipped
  }
  return { role: msg.role, content: parts }
}
