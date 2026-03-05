/**
 * Anthropic provider adapter.
 *
 * Wraps @anthropic-ai/sdk to implement the ProviderAdapter interface.
 * Supports chat completions with text, images, and tool use.
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
    const messages: Anthropic.MessageParam[] = params.messages.map((msg) => {
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
          // Assistant turn re-fed with its own tool calls
          parts.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          })
        } else if (block.type === 'tool_result') {
          parts.push({
            type: 'tool_result',
            tool_use_id: block.toolCallId,
            content: block.content,
            is_error: block.isError,
          })
        }
      }
      return { role: msg.role, content: parts }
    })

    // Convert normalized ToolDef[] → Anthropic Tool[]
    const tools: Anthropic.Tool[] | undefined = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool['input_schema'],
    }))

    const request: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      ...(params.system ? { system: params.system } : {}),
      ...(tools ? { tools } : {}),
    }

    const response = await client.messages.create(request)

    // Translate response → normalized ChatResult
    const toolCalls: ToolCall[] = []
    const rawBlocks: ContentBlock[] = []
    let text = ''

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text
        rawBlocks.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        const tc: ToolCall = {
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        }
        toolCalls.push(tc)
        rawBlocks.push({ type: 'tool_call', id: block.id, name: block.name, input: tc.input })
      }
    }

    const stopReason =
      response.stop_reason === 'tool_use' ? 'tool_use'
      : response.stop_reason === 'max_tokens' ? 'max_tokens'
      : response.stop_reason === 'end_turn' ? 'end_turn'
      : 'other'

    return { text, stopReason, toolCalls, rawBlocks }
  },
  // No embed() — Anthropic does not offer an embeddings API
}
