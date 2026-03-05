/**
 * OpenAI provider adapter.
 *
 * Wraps the `openai` SDK to implement ProviderAdapter.
 * Supports both chat completions (with tool use) and embeddings.
 */

import OpenAI from 'openai'
import type {
  ProviderAdapter,
  ModelDef,
  ChatParams,
  ChatResult,
  EmbedResult,
  ContentBlock,
  ToolCall,
} from './types'

/** Fallback used by the registry when no models have been fetched yet. */
export const OPENAI_POPULAR_MODELS: ModelDef[] = [
  { id: 'gpt-4.1',                label: 'GPT-4.1',                 capabilities: ['chat'] },
  { id: 'gpt-4o',                 label: 'GPT-4o',                  capabilities: ['chat'] },
  { id: 'o4-mini',                label: 'o4-mini',                 capabilities: ['chat'] },
  { id: 'gpt-image-1',            label: 'GPT Image 1',             capabilities: ['image'] },
  { id: 'text-embedding-3-small', label: 'text-embedding-3-small',  capabilities: ['embedding'] },
]

const EMBEDDING_DIMENSIONS = 1536
const EMBED_BATCH_SIZE = 100

/** Derive a human-readable label from a model ID. */
function labelFor(id: string): string {
  return id
    .replace(/^gpt-/, 'GPT-')
    .replace(/^o(\d)/, 'o$1')
    .replace(/-(\d{4})$/, '')       // strip date suffixes like -0125
    .replace(/-preview$/, ' (preview)')
    .replace(/-(\d{4}-\d{2}-\d{2})$/, '')  // strip yyyy-mm-dd suffixes
}

/** Patterns that identify models to skip entirely (legacy, audio-only, fine-tune prefixes). */
const SKIP_RE = /^(whisper|tts|babbage|davinci|curie|ada|text-davinci|text-moderation|ft:|gpt-3\.5|chatgpt-4o-latest|omni-moderation|audio|computer-use)/i

/** Patterns that identify image generation models. */
const IMAGE_RE = /^(dall-e|gpt-image)/i

export const openaiAdapter: ProviderAdapter = {
  async fetchModels(apiKey: string): Promise<ModelDef[]> {
    const client = new OpenAI({ apiKey })
    const response = await client.models.list()

    const models: ModelDef[] = []
    for (const m of response.data) {
      if (SKIP_RE.test(m.id)) continue
      const isEmbedding = m.id.includes('embedding')
      const isImage = IMAGE_RE.test(m.id)
      models.push({
        id: m.id,
        label: labelFor(m.id),
        capabilities: isEmbedding ? ['embedding'] : isImage ? ['image'] : ['chat'],
      })
    }

    // Sort: chat first, then image, then embedding; within each group newest first
    const rank = (caps: string[]) =>
      caps.includes('chat') ? 0 : caps.includes('image') ? 1 : 2
    models.sort((a, b) => {
      const diff = rank(a.capabilities) - rank(b.capabilities)
      if (diff !== 0) return diff
      return b.id.localeCompare(a.id)
    })

    return models
  },

  async chat(params: ChatParams, apiKey: string): Promise<ChatResult> {
    const client = new OpenAI({ apiKey })

    // Convert normalized messages → OpenAI ChatCompletionMessageParam[]
    const messages: OpenAI.ChatCompletionMessageParam[] = []

    if (params.system) {
      messages.push({ role: 'system', content: params.system })
    }

    for (const msg of params.messages) {
      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content })
        } else {
          // Assistant turn: may contain text + tool_call blocks
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
        // user turn
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content })
        } else {
          const parts: OpenAI.ChatCompletionContentPart[] = []
          for (const block of msg.content) {
            if (block.type === 'text') {
              parts.push({ type: 'text', text: block.text })
            } else if (block.type === 'image') {
              parts.push({
                type: 'image_url',
                image_url: { url: `data:${block.mediaType};base64,${block.data}` },
              })
            } else if (block.type === 'tool_result') {
              // Tool results go as separate messages in OpenAI's format
              messages.push({
                role: 'tool',
                tool_call_id: block.toolCallId,
                content: block.content,
              })
            }
          }
          if (parts.length > 0) {
            messages.push({ role: 'user', content: parts })
          }
        }
      }
    }

    // Convert normalized ToolDef[] → OpenAI ChatCompletionTool[]
    const tools: OpenAI.ChatCompletionTool[] | undefined = params.tools?.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }))

    const response = await client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
      ...(tools ? { tools, tool_choice: 'auto' } : {}),
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
      try { input = JSON.parse(tc.function.arguments) } catch { /* ignore */ }
      toolCalls.push({ id: tc.id, name: tc.function.name, input })
      rawBlocks.push({ type: 'tool_call', id: tc.id, name: tc.function.name, input })
    }

    const stopReason =
      choice.finish_reason === 'tool_calls' ? 'tool_use'
      : choice.finish_reason === 'length' ? 'max_tokens'
      : choice.finish_reason === 'stop' ? 'end_turn'
      : 'other'

    return { text, stopReason, toolCalls, rawBlocks }
  },

  async embed(texts: string[], modelId: string, apiKey: string): Promise<EmbedResult[]> {
    const client = new OpenAI({ apiKey })
    const results: EmbedResult[] = []

    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
      const response = await client.embeddings.create({
        model: modelId,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: 'float',
      })
      for (const item of response.data) {
        results.push({
          index: i + item.index,
          embedding: new Float32Array(item.embedding),
        })
      }
    }

    return results
  },
}
