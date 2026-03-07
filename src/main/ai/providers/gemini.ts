/**
 * Google Gemini provider adapter.
 *
 * Uses the Gemini REST API via native fetch — no extra package required.
 * Supports chat completions with text, images, and tool use.
 * Also supports text embeddings via the embedding endpoint.
 *
 * REST reference: https://ai.google.dev/api/generate-content
 */

import type {
  ProviderAdapter,
  ModelDef,
  ChatParams,
  ChatResult,
  EmbedResult,
  ContentBlock,
  ToolCall,
  ImageGenParams,
  ImageGenResult,
} from './types'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

/** Curated models exposed in the Settings UI. */
export const GEMINI_POPULAR_MODELS: ModelDef[] = [
  { id: 'gemini-2.5-pro',                        label: 'Gemini 2.5 Pro',           capabilities: ['chat'] },
  { id: 'gemini-2.5-flash',                       label: 'Gemini 2.5 Flash',         capabilities: ['chat'] },
  { id: 'gemini-2.0-flash-lite',                  label: 'Gemini 2.0 Flash Lite',    capabilities: ['chat'] },
  { id: 'gemini-2.0-flash-exp-image-generation',  label: 'Gemini 2.0 Flash Image',   capabilities: ['image'] },
  { id: 'imagen-3.0-generate-002',                label: 'Imagen 3',                 capabilities: ['image'] },
  { id: 'text-embedding-004',                     label: 'Gemini Embedding 004',     capabilities: ['embedding'] },
]


// ── REST helpers ──────────────────────────────────────────────────────────────

async function geminiPost<T>(path: string, apiKey: string, body: unknown): Promise<T> {
  const url = `${BASE_URL}${path}?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Gemini API error ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

async function geminiGet<T>(path: string, apiKey: string): Promise<T> {
  const url = `${BASE_URL}${path}?key=${encodeURIComponent(apiKey)}`
  const res = await fetch(url)
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new Error(`Gemini API error ${res.status}: ${text}`)
  }
  return res.json() as Promise<T>
}

// ── Gemini REST types (minimal subset) ───────────────────────────────────────

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiFunctionTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

/** Google Search grounding tool — Gemini executes searches server-side. */
interface GeminiGoogleSearchTool {
  googleSearch: Record<string, never>
}

type GeminiTool = GeminiFunctionTool | GeminiGoogleSearchTool

interface GeminiCandidate {
  content: GeminiContent
  finishReason?: string
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
}

interface GeminiModelsResponse {
  models?: Array<{ name: string; displayName?: string; supportedGenerationMethods?: string[] }>
}

/** Image generation models — Imagen uses `predict`; Gemini Flash image-gen uses `generateContent`. */
const GEMINI_IMAGE_RE = /^(imagen|gemini-.+-image)/i

/** Legacy PaLM / AQA models to skip. */
const GEMINI_SKIP_RE = /^(aqa|text-bison|chat-bison|code-bison|codechat-bison|text-unicorn|embedding-gecko)/i

// ── Conversion helpers ────────────────────────────────────────────────────────

function toGeminiContents(params: ChatParams): GeminiContent[] {
  const contents: GeminiContent[] = []

  for (const msg of params.messages) {
    const role: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    if (typeof msg.content === 'string') {
      parts.push({ text: msg.content })
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          parts.push({ text: block.text })
        } else if (block.type === 'image') {
          parts.push({ inlineData: { mimeType: block.mediaType, data: block.data } })
        } else if (block.type === 'tool_call') {
          parts.push({ functionCall: { name: block.name, args: block.input } })
        } else if (block.type === 'tool_result') {
          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(block.content) } catch { parsed = { result: block.content } }
          parts.push({ functionResponse: { name: block.toolName, response: parsed } })
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts })
    }
  }

  return contents
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export const geminiAdapter: ProviderAdapter = {
  async fetchModels(apiKey: string): Promise<ModelDef[]> {
    const data = await geminiGet<GeminiModelsResponse>('/models', apiKey)
    const liveModels = data.models ?? []

    const models: ModelDef[] = []
    for (const m of liveModels) {
      const id = m.name.replace(/^models\//, '')
      if (GEMINI_SKIP_RE.test(id)) continue

      const methods = m.supportedGenerationMethods ?? []
      let capabilities: ('chat' | 'embedding' | 'image')[]

      if (GEMINI_IMAGE_RE.test(id)) {
        capabilities = ['image']
      } else if (methods.includes('embedContent') || methods.includes('batchEmbedContents')) {
        capabilities = ['embedding']
      } else if (methods.includes('generateContent')) {
        capabilities = ['chat']
      } else {
        continue // No usable capability
      }

      models.push({ id, label: m.displayName ?? id, capabilities })
    }

    // Sort: chat first, image second, embedding last; within each group newest first
    const rank = (caps: string[]) =>
      caps.includes('chat') ? 0 : caps.includes('image') ? 1 : 2
    models.sort((a, b) => {
      const diff = rank(a.capabilities) - rank(b.capabilities)
      if (diff !== 0) return diff
      return b.id.localeCompare(a.id)
    })

    return models.length > 0 ? models : GEMINI_POPULAR_MODELS
  },

  async chat(params: ChatParams, apiKey: string): Promise<ChatResult> {
    const contents = toGeminiContents(params)

    // Prepend system instruction as a user turn if provided (Gemini supports
    // systemInstruction field but requires a specific API version; using
    // a leading user/model exchange is universally compatible)
    const body: Record<string, unknown> = { contents }

    if (params.system) {
      body['systemInstruction'] = { parts: [{ text: params.system }] }
    }

    const geminiTools: GeminiTool[] = []

    if (params.tools && params.tools.length > 0) {
      geminiTools.push({
        functionDeclarations: params.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
      })
    }

    // Google Search grounding — Gemini executes searches server-side and returns
    // a final answer in a single turn. No client-side looping required.
    if (params.webSearch) {
      geminiTools.push({ googleSearch: {} })
    }

    if (geminiTools.length > 0) {
      body['tools'] = geminiTools
    }

    body['generationConfig'] = { maxOutputTokens: params.maxTokens }

    const modelId = params.model.startsWith('models/') ? params.model : `models/${params.model}`
    const data = await geminiPost<GeminiResponse>(
      `/${modelId}:generateContent`,
      apiKey,
      body,
    )

    const candidate = data.candidates?.[0]
    const rawBlocks: ContentBlock[] = []
    const toolCalls: ToolCall[] = []
    let text = ''

    for (const part of candidate?.content?.parts ?? []) {
      if (part.text) {
        text += part.text
        rawBlocks.push({ type: 'text', text: part.text })
      } else if (part.functionCall) {
        const tc: ToolCall = {
          id: `${part.functionCall.name}-${Date.now()}`,
          name: part.functionCall.name,
          input: part.functionCall.args,
        }
        toolCalls.push(tc)
        rawBlocks.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input })
      }
    }

    const finishReason = candidate?.finishReason ?? ''
    const stopReason =
      toolCalls.length > 0 ? 'tool_use'
      : finishReason === 'MAX_TOKENS' ? 'max_tokens'
      : finishReason === 'STOP' ? 'end_turn'
      : 'other'

    return { text, stopReason, toolCalls, rawBlocks }
  },

  async embed(texts: string[], modelId: string, apiKey: string): Promise<EmbedResult[]> {
    const model = modelId.startsWith('models/') ? modelId : `models/${modelId}`
    const results: EmbedResult[] = []

    // Gemini batchEmbedContents supports up to 100 texts per request
    const BATCH = 100
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH)
      const body = {
        requests: batch.map((text) => ({
          model,
          content: { parts: [{ text }] },
        })),
      }

      interface BatchEmbedResponse {
        embeddings?: Array<{ values: number[] }>
      }
      const data = await geminiPost<BatchEmbedResponse>(
        `/${model}:batchEmbedContents`,
        apiKey,
        body,
      )

      for (let j = 0; j < (data.embeddings?.length ?? 0); j++) {
        results.push({
          index: i + j,
          embedding: new Float32Array(data.embeddings![j].values),
        })
      }
    }

    return results
  },

  async generateImage(params: ImageGenParams, apiKey: string): Promise<ImageGenResult> {
    const modelId = params.model.startsWith('models/') ? params.model : `models/${params.model}`
    const isImagen = /^models\/imagen/i.test(modelId)

    if (isImagen) {
      // Imagen models use the :predict endpoint with instances/parameters format
      interface ImagenResponse {
        predictions?: Array<{ bytesBase64Encoded: string; mimeType?: string }>
      }
      const sizeToAspect: Record<string, string> = {
        '1024x1024': '1:1',
        '1536x1024': '3:2',
        '1024x1536': '2:3',
      }
      const body = {
        instances: [{ prompt: params.prompt }],
        parameters: {
          sampleCount: 1,
          aspectRatio: sizeToAspect[params.size ?? '1024x1024'] ?? '1:1',
        },
      }
      const data = await geminiPost<ImagenResponse>(`/${modelId}:predict`, apiKey, body)
      const prediction = data.predictions?.[0]
      if (!prediction?.bytesBase64Encoded) {
        throw new Error('Imagen API returned no image data')
      }
      return {
        base64: prediction.bytesBase64Encoded,
        mimeType: (prediction.mimeType as ImageGenResult['mimeType']) ?? 'image/png',
      }
    }

    // Gemini Flash image-generation models use :generateContent with responseModalities
    interface FlashImageResponse {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }
      }>
    }
    const body = {
      contents: [{ role: 'user', parts: [{ text: params.prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], maxOutputTokens: 4096 },
    }
    const data = await geminiPost<FlashImageResponse>(`/${modelId}:generateContent`, apiKey, body)
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const imagePart = parts.find((p) => p.inlineData?.data)
    if (!imagePart?.inlineData) {
      throw new Error('Gemini image generation returned no image data')
    }
    return {
      base64: imagePart.inlineData.data,
      mimeType: (imagePart.inlineData.mimeType as ImageGenResult['mimeType']) ?? 'image/png',
    }
  },
}
