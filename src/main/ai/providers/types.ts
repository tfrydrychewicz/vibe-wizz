/**
 * Provider-agnostic types for the multi-provider AI model layer.
 *
 * All adapters (Anthropic, OpenAI, Gemini) implement ProviderAdapter using
 * these normalized types. The model router talks to adapters exclusively through
 * this interface — no SDK-specific types leak out.
 */

// ── Content blocks ────────────────────────────────────────────────────────────

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ImageBlock {
  type: 'image'
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
  /** Base64-encoded image data */
  data: string
}

/** Assistant requested a tool call. Used when building multi-turn conversations. */
export interface ToolCallBlock {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
}

/** Tool result returned by the caller. Role must be 'user' when in ChatMessage.content. */
export interface ToolResultBlock {
  type: 'tool_result'
  toolCallId: string
  toolName: string
  /** JSON-serialized result or plain error text */
  content: string
  isError?: boolean
}

export type ContentBlock = TextBlock | ImageBlock | ToolCallBlock | ToolResultBlock

// ── Messages ─────────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/** Provider-agnostic tool definition (JSON Schema for input). */
export interface ToolDef {
  name: string
  description: string
  /** JSON Schema object describing the tool's input parameters */
  inputSchema: Record<string, unknown>
}

// ── Chat params / result ──────────────────────────────────────────────────────

export interface ChatParams {
  model: string
  /** Separate system prompt (adapters inject it in the provider-native way) */
  system?: string
  messages: ChatMessage[]
  maxTokens: number
  tools?: ToolDef[]
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ChatResult {
  /** Concatenated text content from the response */
  text: string
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'other'
  /** Populated when stopReason === 'tool_use' */
  toolCalls: ToolCall[]
  /** Raw assistant content blocks for re-feeding into multi-turn messages */
  rawBlocks: ContentBlock[]
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export interface EmbedResult {
  index: number
  /** Float32Array in the provider's native dimensionality */
  embedding: Float32Array
}

// ── Model discovery ───────────────────────────────────────────────────────────

export interface ModelDef {
  id: string
  label: string
  capabilities: ('chat' | 'embedding' | 'image')[]
}

// ── Provider adapter interface ────────────────────────────────────────────────

export interface ProviderAdapter {
  /**
   * Fetch the provider's current popular models, validating the API key as a
   * side-effect. Returns only models in the curated POPULAR_MODELS list for
   * this provider so the UI doesn't show hundreds of fine-tuned variants.
   */
  fetchModels(apiKey: string): Promise<ModelDef[]>

  /**
   * Execute a single-turn or multi-turn chat completion.
   * Translates normalized ChatParams to the provider's native API format.
   */
  chat(params: ChatParams, apiKey: string): Promise<ChatResult>

  /**
   * Generate embeddings. Only required for providers that support it
   * (OpenAI, Gemini — not Anthropic).
   */
  embed?(texts: string[], modelId: string, apiKey: string): Promise<EmbedResult[]>
}
