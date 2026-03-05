# Multi-Provider AI Model Configuration

## Overview

Replace all hardcoded model references with a configurable, provider-agnostic model routing layer. Users can register API keys for multiple providers (Anthropic, OpenAI, Google Gemini), select which models to make available, and define per-feature model chains with automatic fallback.

---

## Current State — Hardcoded Models

Every AI feature currently has a hardcoded model constant:

| Feature | File | Current Model |
|---------|------|---------------|
| AI Chat (conversation) | `embedding/chat.ts` | `claude-sonnet-4-6` |
| Query expansion / re-ranking | `embedding/chat.ts` | `claude-haiku-4-5-20251001` |
| Inline AI generation | `embedding/chat.ts` | `claude-haiku-4-5-20251001` |
| Note summarizer (L2) | `embedding/summarizer.ts` | `claude-haiku-4-5-20251001` |
| NER entity detection | `embedding/ner.ts` | `claude-haiku-4-5-20251001` |
| Action item extraction | `embedding/actionExtractor.ts` | `claude-haiku-4-5-20251001` |
| Cluster summaries (L3) | `embedding/clusterBuilder.ts` | `claude-haiku-4-5-20251001` |
| Daily Brief | `embedding/dailyBrief.ts` | `claude-sonnet-4-6` |
| Transcription post-processor | `transcription/postProcessor.ts` | `claude-haiku-4-5-20251001` |
| Embeddings (vector) | `embedding/embedder.ts` | `text-embedding-3-small` (OpenAI) |

---

## Design

### Concepts

**Provider** — An AI API vendor (Anthropic, OpenAI, Google Gemini). Each has a key, a list of available models, and a standard completion format.

**Enabled model** — A specific model ID that the user has opted into from a provider. Only enabled models appear as options in the UI.

**Feature slot** — A named AI task in the app (e.g. `chat`, `note_summary`, `daily_brief`). Each slot has a user-configurable **model chain**: an ordered list of enabled models. The app tries them in order, falling back on error.

**Model chain** — `[primary, fallback1, fallback2, ...]`. If the primary call fails (API error, rate limit, model unavailable), the next model in the chain is tried automatically and silently. The last failure is re-thrown if all models fail.

---

### Data Model

#### New Tables

```sql
-- Registered providers (one row per vendor the user has configured)
CREATE TABLE IF NOT EXISTS ai_providers (
  id        TEXT PRIMARY KEY,          -- e.g. 'anthropic', 'openai', 'gemini'
  api_key   TEXT NOT NULL DEFAULT '',
  enabled   INTEGER NOT NULL DEFAULT 1 -- 0 = disabled (key removed but history preserved)
);

-- Models the user has selected/enabled per provider
CREATE TABLE IF NOT EXISTS ai_models (
  id           TEXT PRIMARY KEY,        -- provider model ID, e.g. 'claude-sonnet-4-6'
  provider_id  TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,           -- human-readable, e.g. 'Claude Sonnet 4.6'
  capabilities TEXT NOT NULL DEFAULT 'chat', -- JSON array: ['chat','embedding']
  enabled      INTEGER NOT NULL DEFAULT 1
);

-- Per-feature model chain (ordered list of model IDs)
CREATE TABLE IF NOT EXISTS ai_feature_models (
  feature_slot TEXT NOT NULL,           -- e.g. 'chat', 'note_summary'
  position     INTEGER NOT NULL,        -- 0 = primary, 1 = first fallback, ...
  model_id     TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_slot, position)
);
```

#### Feature Slot Registry

Defined in a new TypeScript file — the canonical list of all AI feature slots in the app:

```typescript
// src/main/ai/featureSlots.ts
export const FEATURE_SLOTS = [
  { id: 'chat',             label: 'AI Chat (conversation)',    capability: 'chat' },
  { id: 'note_summary',     label: 'Note Summary (background)', capability: 'chat' },
  { id: 'ner',              label: 'Entity Detection (NER)',     capability: 'chat' },
  { id: 'action_extract',   label: 'Action Item Extraction',     capability: 'chat' },
  { id: 'inline_ai',        label: 'Inline AI Generation',       capability: 'chat' },
  { id: 'daily_brief',      label: 'Daily Brief',                capability: 'chat' },
  { id: 'cluster_summary',  label: 'Cluster Summaries (L3)',     capability: 'chat' },
  { id: 'query_expand',     label: 'Query Expansion',            capability: 'chat' },
  { id: 'rerank',           label: 'Search Re-ranking',          capability: 'chat' },
  { id: 'meeting_summary',  label: 'Meeting Transcript Summary', capability: 'chat' },
  { id: 'embedding',        label: 'Vector Embeddings',          capability: 'embedding' },
] as const

export type FeatureSlotId = typeof FEATURE_SLOTS[number]['id']
```

#### Migration

Migration `0006_ai_providers.ts`:
- Creates `ai_providers`, `ai_models`, `ai_feature_models` tables
- Seeds default data from existing `settings` keys (`anthropic_api_key`, `openai_api_key`) so existing users are not broken:
  - If `anthropic_api_key` exists → insert Anthropic provider + default Anthropic models (Opus 4.6, Sonnet 4.6, Haiku 4.5) as enabled + set default chains for all features that currently use Claude
  - If `openai_api_key` exists → insert OpenAI provider + `text-embedding-3-small` as enabled + set `embedding` chain
- Old settings keys retained for now (backward compat); future migration can remove them

---

### Provider Abstraction Layer

```
src/main/ai/
├── featureSlots.ts        — FEATURE_SLOTS registry + FeatureSlotId type
├── modelRouter.ts         — resolveChain(), callWithFallback()
├── providers/
│   ├── types.ts           — ProviderAdapter interface
│   ├── anthropic.ts       — AnthropicAdapter
│   ├── openai.ts          — OpenAIAdapter
│   └── gemini.ts          — GeminiAdapter
└── registry.ts            — listProviderDefs(), getProviderModels()
```

#### `ProviderAdapter` interface

```typescript
interface ProviderAdapter {
  /** Fetch the current list of popular models from the provider's /models endpoint */
  fetchModels(apiKey: string): Promise<ModelDef[]>

  /** Execute a chat completion (single turn or multi-turn) */
  chat(params: ChatParams, apiKey: string): Promise<ChatResult>

  /** Generate embeddings (only required for embedding-capable providers) */
  embed?(texts: string[], apiKey: string): Promise<number[][]>
}

interface ModelDef {
  id: string
  label: string
  capabilities: ('chat' | 'embedding')[]
}

interface ChatParams {
  model: string
  messages: { role: 'user' | 'assistant' | 'system'; content: string | ContentBlock[] }[]
  system?: string
  max_tokens: number
  tools?: Tool[]   // forwarded to providers that support tool use (Anthropic, OpenAI, Gemini)
}
```

#### `modelRouter.ts`

```typescript
/**
 * Resolve the ordered model chain for a feature slot.
 * Returns [primary, ...fallbacks] as configured in ai_feature_models.
 * Falls back to built-in defaults if no user configuration exists.
 */
function resolveChain(featureSlot: FeatureSlotId, db: Database): ResolvedModel[]

/**
 * Execute fn(model) trying each model in the chain.
 * On success returns the result. On failure, logs and tries the next.
 * Throws AggregateError if all fail.
 */
async function callWithFallback<T>(
  featureSlot: FeatureSlotId,
  db: Database,
  fn: (model: ResolvedModel) => Promise<T>
): Promise<T>

interface ResolvedModel {
  modelId: string         // e.g. 'claude-sonnet-4-6'
  providerId: string      // e.g. 'anthropic'
  apiKey: string
  adapter: ProviderAdapter
}
```

All existing embedding files (`chat.ts`, `summarizer.ts`, `ner.ts`, etc.) are refactored to call `callWithFallback(slot, db, model => ...)` instead of using hardcoded model constants and direct Anthropic SDK calls.

---

### Provider Model Discovery

Each provider adapter implements `fetchModels(apiKey)` against the provider's models endpoint. The Settings UI calls `ai-providers:fetch-models` IPC to populate checkboxes.

| Provider | Models endpoint | Auth |
|----------|----------------|------|
| Anthropic | `GET https://api.anthropic.com/v1/models` | `x-api-key` header |
| OpenAI | `GET https://api.openai.com/v1/models` | `Authorization: Bearer` |
| Google Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models` | `?key=` query param |

The app filters the returned list to a curated set of 2–3 most popular models per provider (rather than showing hundreds of fine-tuned variants):

```typescript
// registry.ts — curated popular models per provider
const POPULAR_MODELS: Record<string, string[]> = {
  anthropic: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  openai:    ['gpt-4o', 'gpt-4o-mini', 'o3'],
  gemini:    ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash-lite'],
}
```

The `fetchModels` call validates the API key and returns the intersection of the provider's live models and the curated list (so the UI always shows accurate, up-to-date model IDs).

---

### Settings UI

The existing Settings modal gains a new top-level **AI Providers** tab (replacing the flat key inputs).

#### AI Providers tab layout

```
AI Providers
├── [+ Add Provider] button
│
├── ┌─────────────────────────────────────────────────────┐
│   │  Anthropic                                   ✅ Enabled │
│   │  API Key: sk-ant-*********************  [Test] │
│   │                                                     │
│   │  Available models:                                  │
│   │  ☑ Claude Opus 4.6                                  │
│   │  ☑ Claude Sonnet 4.6                                │
│   │  ☑ Claude Haiku 4.5                                 │
│   └─────────────────────────────────────────────────────┘
│
├── ┌─────────────────────────────────────────────────────┐
│   │  OpenAI                                      ✅ Enabled │
│   │  API Key: sk-*********************  [Test]          │
│   │                                                     │
│   │  Available models:                                  │
│   │  ☑ GPT-4o                                           │
│   │  ☐ GPT-4o mini                                      │
│   │  ☐ o3                                               │
│   └─────────────────────────────────────────────────────┘
│
└── ┌─────────────────────────────────────────────────────┐
    │  Google Gemini                              ➕ Add key │
    └─────────────────────────────────────────────────────┘
```

#### AI Features tab (separate from Providers)

Lists all feature slots; each row has a drag-reorderable model chain builder:

```
Feature               Model Chain
─────────────────────────────────────────────────────────
AI Chat               [Claude Sonnet 4.6 ▾] → [GPT-4o ▾] → [+ Add fallback]
Daily Brief           [Claude Sonnet 4.6 ▾] → [+ Add fallback]
Note Summary          [Claude Haiku 4.5 ▾] → [+ Add fallback]
Entity Detection      [Claude Haiku 4.5 ▾] → [+ Add fallback]
Action Extraction     [Claude Haiku 4.5 ▾] → [+ Add fallback]
Inline AI             [Claude Haiku 4.5 ▾] → [+ Add fallback]
Meeting Summary       [Claude Haiku 4.5 ▾] → [+ Add fallback]
Cluster Summaries     [Claude Haiku 4.5 ▾] → [+ Add fallback]
Query Expansion       [Claude Haiku 4.5 ▾] → [+ Add fallback]
Search Re-ranking     [Claude Haiku 4.5 ▾] → [+ Add fallback]
Vector Embeddings     [text-embedding-3-small (OpenAI) ▾]
```

Model dropdowns only show models that: (a) are enabled in the Providers tab, and (b) match the slot's required capability (`chat` or `embedding`).

---

### IPC Reference

| Channel | Direction | Payload | Returns |
|---------|-----------|---------|---------|
| `ai-providers:list` | invoke | — | `ProviderRow[]` with enabled model IDs |
| `ai-providers:save` | invoke | `{ id, apiKey, enabledModelIds }` | `{ ok, error? }` |
| `ai-providers:fetch-models` | invoke | `{ id, apiKey }` | `ModelDef[]` |
| `ai-providers:delete` | invoke | `{ id }` | `{ ok }` |
| `ai-feature-models:list` | invoke | — | `FeatureChain[]` (`{ featureSlot, models: ModelRef[] }`) |
| `ai-feature-models:save` | invoke | `{ featureSlot, modelIds: string[] }` | `{ ok }` |

---

### Default / Fallback Behavior

- If a feature slot has no user-configured chain, `resolveChain` returns built-in defaults (current hardcoded values) so the app works out-of-the-box after migration.
- If a model is removed/disabled while in a chain, `resolveChain` silently skips it.
- If the chain becomes empty, the app shows the same "set API key" message it shows today.

---

## Implementation Checklist

### Phase A — Data Model & Migration ✅
- [x] Create `src/main/ai/featureSlots.ts` — `FEATURE_SLOTS` array, `FeatureSlotId` type, `DEFAULT_CHAINS`
- [x] Create migration `0007_ai_providers.ts` — `ai_providers`, `ai_models`, `ai_feature_models` tables
  - Seed from existing `anthropic_api_key` / `openai_api_key` settings with all default models enabled
  - Set default chains for all feature slots matching current hardcoded assignments
- [x] Register migration in `ALL_MIGRATIONS` in `src/main/db/migrations/index.ts`
- [x] Add new tables to `schema.ts` (`CREATE TABLE IF NOT EXISTS`) for fresh installs

### Phase B — Provider Adapters ✅
- [x] Create `src/main/ai/providers/types.ts` — `ProviderAdapter`, `ModelDef`, `ChatParams`, `ChatResult`, `ContentBlock`, `ToolDef`, `ToolCall`, `EmbedResult` interfaces
- [x] Create `src/main/ai/providers/anthropic.ts` — `anthropicAdapter` (wraps `@anthropic-ai/sdk`; `fetchModels` + `chat`; no `embed`)
- [x] Create `src/main/ai/providers/openai.ts` — `openaiAdapter` (wraps `openai` SDK; `fetchModels` + `chat` + `embed`)
- [x] Create `src/main/ai/providers/gemini.ts` — `geminiAdapter` (native fetch REST; `fetchModels` + `chat` + `embed`; no extra package)
- [x] Create `src/main/ai/registry.ts` — `PROVIDER_DEFS`, `getAdapter()`, `getProviderDef()`, `listProviderIds()`
- [x] Create `src/main/ai/modelRouter.ts` — `resolveChain()` (DB → fallback to `DEFAULT_CHAINS`), `callWithFallback()` (try-each with `AggregateError`)

### Phase C — IPC Handlers ✅
- [x] Add `ai-providers:list` handler — returns providers with label, api_key, enabled flag, and model list
- [x] Add `ai-providers:save` handler — upserts provider + replaces all model rows for the provider
- [x] Add `ai-providers:fetch-models` handler — calls `adapter.fetchModels(apiKey)`; returns `ModelDef[]`
- [x] Add `ai-providers:delete` handler — hard-deletes provider (cascades to ai_models + ai_feature_models)
- [x] Add `ai-feature-models:list` handler — returns chain for every `FEATURE_SLOTS` entry with labels
- [x] Add `ai-feature-models:save` handler — replaces ordered chain rows for one feature slot
- [x] All handlers registered in `src/main/db/ipc.ts`
- [x] No preload change needed — generic `invoke`/`send`/`on` bridge already covers all channels

### Phase D — Refactor AI Feature Files ✅
Replace every hardcoded model constant with a `callWithFallback` call:
- [x] `src/main/embedding/chat.ts` — `sendChatMessage` (slot: `chat`), `expandQueryConcepts` (`query_expand`), `reRankResults` (`rerank`), `generateInlineContent` (`inline_ai`)
- [x] `src/main/embedding/summarizer.ts` — `summarizeNote` (slot: `note_summary`)
- [x] `src/main/embedding/ner.ts` — `detectEntityMentions` (slot: `ner`)
- [x] `src/main/embedding/actionExtractor.ts` — extraction call (slot: `action_extract`)
- [x] `src/main/embedding/dailyBrief.ts` — brief generation (slot: `daily_brief`)
- [x] `src/main/embedding/clusterBuilder.ts` — cluster theme summary (slot: `cluster_summary`)
- [x] `src/main/transcription/postProcessor.ts` — meeting summary (slot: `meeting_summary`)
- [x] `src/main/embedding/embedder.ts` — embedding call (slot: `embedding`)
- [x] Remove all `DEFAULT_MODEL` constants and direct Anthropic/OpenAI singleton client management from individual files (move client lifecycle into adapters)

### Phase E — Settings UI ✅
- [x] Create `src/renderer/components/AIProviderCard.vue` — single provider panel: API key input, [Test/Fetch] button, model checkboxes; emits `saved` / `deleted`
- [x] Create `src/renderer/components/FeatureChainEditor.vue` — one row per feature slot; dropdowns populated from enabled models; [+ fallback] / [×] remove; emits `change: [{ featureSlot, modelIds }]`
- [x] **LLM Providers** sub-tab in `SettingsModal.vue` AI section — lists providers from `ai-providers:list`; [+ Add Provider] picker (Anthropic / OpenAI / Google Gemini); each provider renders `AIProviderCard`; [Test] calls `ai-providers:fetch-models`; save calls `ai-providers:save`
- [x] **AI Features** sub-tab (renamed from "Models") — loads chains via `ai-feature-models:list`; one `FeatureChainEditor` per slot; on chain change calls `ai-feature-models:save` immediately
- [x] Removed standalone `openai_api_key` and `anthropic_api_key` inputs from Settings (now managed via Providers tab)
- [x] Removed old `model_chat`, `model_daily_brief`, `model_background` dropdowns (now managed via AI Features tab)

### Phase F — Chat Sidebar Model Picker ✅
- [x] In `ChatSidebar.vue`, model selector dropdown in header (populated from `ai-providers:list` chat-capable enabled models); selected model stored in `chatStore.selectedModelId` and forwarded as `overrideModelId` in `chat:send` payload; hidden when ≤1 model available
- [x] `chat:send` handler accepts `overrideModelId?`; passes to `sendChatMessage`; `callWithFallback` moves the override to front of chain; remaining models serve as fallbacks

### Phase G — Error Handling & Observability ✅
- [x] Fallback attempts logged to main process console with model ID and error message (`console.warn` in `callWithFallback`)
- [x] When fallback fires, renderer receives `{ warning }` field — `ChatSidebar` shows subtle italic note below assistant bubble
- [x] If all chain entries fail, actionable error: "No AI models available. Open Settings → AI Providers to add an API key."

### Phase H — Cleanup
- [ ] Remove `openai_api_key` and `anthropic_api_key` from the `settings` table knowledge (settings:get/set still works but UI no longer writes them)
- [ ] Remove the `AVAILABLE_MODELS` export from `chat.ts` (replaced by dynamic provider list)
- [ ] Update `CLAUDE.md` and `DESIGN.md` with new IPC channels, architecture, and completed checklist items

---

## Non-Goals (out of scope for this feature)

- Local/on-device LLM support (Ollama, etc.) — different capability profile, deferred
- Per-user billing or usage tracking
- Model capability auto-detection beyond the curated `capabilities` field
- Streaming chat responses from non-Anthropic providers (current streaming is Anthropic-specific; other providers get non-streaming responses for now)
