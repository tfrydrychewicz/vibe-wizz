# Ollama Local Provider

## Overview

Add **Ollama** as a fully-supported AI provider alongside Anthropic, OpenAI, and Google Gemini. Ollama runs LLMs locally on the user's machine — no API key, no per-token cost, full data privacy. Users configure a base URL (default `http://localhost:11434`), discover their installed models with one click, and assign them to any `chat` feature slot (NER, action extraction, entity reviews, daily brief, etc.).

This is the primary way to make background AI features (NER, action extraction, entity reviews) free for users who don't want to pay for cloud AI inference.

---

## Problem

All current AI providers (Anthropic, OpenAI, Gemini) require a paid API key. Background features like NER (entity detection after every note save) and action extraction accumulate API costs invisibly. Users who want a zero-cost setup have no supported path — Ollama is already recommended in conversations as the solution, but it is not supported in the Settings UI and requires no code changes to wire up.

The MULTI_PROVIDER_AI feature explicitly deferred Ollama ("local/on-device LLM support — different capability profile, deferred"). This document closes that deferral.

---

## Ollama API Surface (reference)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/tags` | GET | List installed models: `{ models: [{ name, size, details: { family, parameter_size } }] }` |
| `/v1/chat/completions` | POST | OpenAI-compatible chat completions (supports tools for capable models) |
| `/v1/models` | GET | OpenAI-compatible model list (subset of `/api/tags`) |

Ollama's `/v1/` prefix implements the OpenAI REST API spec. The existing `openai` npm package can be re-used by pointing it at `http://localhost:11434` with `apiKey: 'ollama'` (a dummy, required by the SDK but not validated by Ollama).

---

## Key Design Decisions

### 1. "API key" column stores the base URL

The `ai_providers` table has `api_key TEXT NOT NULL DEFAULT ''`. Rather than a schema migration, Ollama stores its **base URL** in the `api_key` column. The column name is an implementation detail; semantically it means "the credential or config string for this provider".

- Default value: `http://localhost:11434`
- Always non-empty → satisfies the `AND p.api_key != ''` guard in `resolveChain` without any router changes
- Users running Ollama on a different host/port (e.g. remote GPU machine) simply change the URL

### 2. `ProviderDef` gains `credentialType` and `credentialDefault`

A minimal, opt-in extension to the existing `ProviderDef` interface:

```typescript
export interface ProviderDef {
  id: string
  label: string
  popularModels: ModelDef[]
  adapter: ProviderAdapter
  /** How the provider authenticates. Defaults to 'api_key'. */
  credentialType?: 'api_key' | 'base_url'
  /** Pre-filled value shown when the provider is first added. */
  credentialDefault?: string
  /** Input placeholder shown in Settings. */
  credentialPlaceholder?: string
}
```

This extension propagates to the `ai-providers:list` IPC response so the renderer can adapt its UI per provider without hardcoding Ollama-specific logic in the component.

### 3. `AIProviderCard.vue` adapts to `credentialType`

`AIProviderCard` gains three optional props: `credentialType`, `credentialDefault`, and `credentialPlaceholder`. When `credentialType === 'base_url'`:
- The input renders as `type="text"` (URL is not a secret — no masking)
- The show/hide toggle button is hidden
- The "Test / Refresh" button is always enabled (URL is always non-empty due to the default)
- Placeholder and label text adapt accordingly (`Base URL` vs `API Key`)

The template and logic changes are purely additive — existing providers see no change.

### 4. No migration needed

Ollama is a new provider entry. No existing rows are affected. The existing `ai_providers`, `ai_models`, and `ai_feature_models` tables handle Ollama without schema changes.

### 5. Phase 1: chat only; embeddings deferred

Ollama embedding models (`nomic-embed-text`: 768d, `mxbai-embed-large`: 1024d, `all-minilm`: 384d) produce vectors of different dimensions than the currently hardcoded FLOAT[1536] in the sqlite-vec tables. Supporting variable embedding dimensions requires migrating the vec0 tables and updating the embedder — a significant change deferred to Phase 2.

Phase 1 marks all Ollama models with `capabilities: ['chat']` only.

### 6. Tool use: best-effort, graceful degradation

The `chat` feature slot uses WIZZ_TOOLS (calendar events, action items, web search). Not all Ollama models support tool use. The Ollama adapter attempts tool use for all models; if the model returns an error or ignores tools, `callWithFallback` will catch and move to the next chain entry. The `ai-providers:fetch-models` response will include a `note` on models known to support tools.

Models confirmed to support tool use via Ollama's OpenAI-compat endpoint:
- `qwen2.5:3b`, `qwen2.5:7b`, `qwen2.5:14b`
- `qwen3:1.7b`, `qwen3:4b`, `qwen3:8b`
- `llama3.1:8b`, `llama3.2:3b`
- `mistral-nemo:12b`

Background slots (NER, action extraction, note summary, entity reviews) do **not** use tools, so any Ollama model works for them.

### 7. Recommended models per feature slot

Shown as hints in the Settings UI (not enforced):

| Feature Slot | Recommended Ollama Model | Reason |
|---|---|---|
| NER / Action Extract / Entity Review | `qwen2.5:3b` or `qwen3:1.7b` | Multilingual (Polish, German, Czech…), fast, excellent JSON output |
| AI Chat (with tools) | `qwen2.5:7b` or `llama3.2:3b` | Tool use support, good reasoning |
| Daily Brief / Note Summary | `qwen2.5:3b` | Good instruction following, ~1GB RAM |
| Query Expand / Rerank | `qwen2.5:1.5b` | Very fast, tiny, sufficient for classification tasks |

---

## Architecture

### New file: `src/main/ai/providers/ollama.ts`

```typescript
/**
 * Ollama local provider adapter.
 *
 * Communicates with Ollama over its OpenAI-compatible /v1/ API.
 * The `apiKey` parameter carries the Ollama base URL
 * (e.g. "http://localhost:11434").
 */
import OpenAI from 'openai'
import type { ProviderAdapter, ModelDef, ChatParams, ChatResult, ContentBlock, ToolCall } from './types'

export const OLLAMA_POPULAR_MODELS: ModelDef[] = []
// Intentionally empty — models are discovered dynamically via fetchModels.

export const ollamaAdapter: ProviderAdapter = {
  async fetchModels(baseUrl: string): Promise<ModelDef[]> {
    // GET /api/tags — Ollama's native list-models endpoint
    const url = baseUrl.replace(/\/$/, '') + '/api/tags'
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`Ollama unreachable at ${baseUrl} (HTTP ${res.status})`)
    const data = await res.json() as { models?: { name: string; details?: { family?: string } }[] }
    const models = data.models ?? []
    return models.map((m) => ({
      id: m.name,
      label: m.name,
      capabilities: ['chat'],  // Phase 1: chat only
    }))
  },

  async chat(params: ChatParams, baseUrl: string): Promise<ChatResult> {
    // Use the OpenAI SDK pointed at the Ollama base URL.
    // Ollama ignores the apiKey; 'ollama' is a required dummy.
    const client = new OpenAI({ baseURL: baseUrl.replace(/\/$/, '') + '/v1', apiKey: 'ollama' })
    // ... (same message mapping as openai.ts, without web search or image blocks)
  },

  // embed intentionally omitted — Phase 1 chat only
}
```

### Changes to `src/main/ai/registry.ts`

```typescript
import { ollamaAdapter, OLLAMA_POPULAR_MODELS } from './providers/ollama'

export const PROVIDER_DEFS: ProviderDef[] = [
  // ... existing providers ...
  {
    id: 'ollama',
    label: 'Ollama (local)',
    popularModels: OLLAMA_POPULAR_MODELS,
    adapter: ollamaAdapter,
    credentialType: 'base_url',
    credentialDefault: 'http://localhost:11434',
    credentialPlaceholder: 'http://localhost:11434',
  },
]
```

### Changes to `src/main/db/ipc.ts` — `ai-providers:list`

The list handler already returns per-provider data. Add `credentialType` and `credentialDefault` to each row by reading them from `getProviderDef()`:

```typescript
// In ai-providers:list handler, per-provider row:
const def = getProviderDef(p.id)  // p.id from DB
return {
  id: p.id,
  label: def.label,
  apiKey: p.api_key,
  enabled: p.enabled === 1,
  credentialType: def.credentialType ?? 'api_key',
  credentialDefault: def.credentialDefault ?? '',
  credentialPlaceholder: def.credentialPlaceholder ?? 'API key',
  models: [ /* ... */ ],
}
```

### Changes to `src/renderer/components/AIProviderCard.vue`

```typescript
// New optional props
const props = defineProps<{
  providerId: string
  providerLabel: string
  apiKey: string
  models: ProviderModel[]
  credentialType?: 'api_key' | 'base_url'         // default: 'api_key'
  credentialDefault?: string
  credentialPlaceholder?: string
}>()

// On mount: if the card is for a base_url provider and localKey is empty, pre-fill the default
onMounted(() => {
  if (props.credentialType === 'base_url' && !localKey.value && props.credentialDefault) {
    localKey.value = props.credentialDefault
  }
})
```

Template adaptations when `credentialType === 'base_url'`:
- Input `type="text"` (not `password`)
- Show/hide toggle button hidden
- "Refresh" button always enabled (URL has a non-empty default)
- Placeholder: `credentialPlaceholder` prop value

### Changes to `src/renderer/components/SettingsModal.vue`

1. Add Ollama to `PROVIDER_OPTIONS`:
   ```typescript
   const PROVIDER_OPTIONS = [
     { id: 'anthropic', label: 'Anthropic' },
     { id: 'openai', label: 'OpenAI' },
     { id: 'gemini', label: 'Google Gemini' },
     { id: 'ollama', label: 'Ollama (local)' },
   ]
   ```

2. Extend `ProviderRow` interface with the new credential fields:
   ```typescript
   interface ProviderRow {
     id: string
     label: string
     apiKey: string
     enabled: boolean
     models: ProviderModel[]
     credentialType?: 'api_key' | 'base_url'
     credentialDefault?: string
     credentialPlaceholder?: string
   }
   ```

3. `addProvider()` pre-fills `apiKey` with `credentialDefault` from the option (read from a static map matching `PROVIDER_OPTIONS`):
   ```typescript
   const PROVIDER_CREDENTIAL_DEFAULTS: Record<string, string> = {
     ollama: 'http://localhost:11434',
   }
   function addProvider(id: string): void {
     if (providers.value.some((p) => p.id === id)) return
     const opt = PROVIDER_OPTIONS.find((o) => o.id === id)!
     providers.value.push({
       id,
       label: opt.label,
       apiKey: PROVIDER_CREDENTIAL_DEFAULTS[id] ?? '',
       enabled: true,
       models: [],
     })
     showAddProvider.value = false
   }
   ```

4. Pass new props to `<AIProviderCard>` in the template:
   ```html
   <AIProviderCard
     v-for="p in providers"
     :key="p.id"
     :provider-id="p.id"
     :provider-label="p.label"
     :api-key="p.apiKey"
     :models="p.models"
     :credential-type="p.credentialType"
     :credential-default="p.credentialDefault"
     :credential-placeholder="p.credentialPlaceholder"
     @deleted="onProviderDeleted(p.id)"
   />
   ```

---

## IPC Reference

No new IPC channels. All existing channels work unchanged:

| Channel | Ollama behaviour |
|---------|-----------------|
| `ai-providers:list` | Returns Ollama row with `credentialType: 'base_url'`, `credentialDefault: 'http://localhost:11434'` |
| `ai-providers:fetch-models` | Calls `ollamaAdapter.fetchModels(apiKey)` where `apiKey` = base URL; queries `/api/tags` |
| `ai-providers:save` | Stores base URL in `api_key` column; upserts model rows as `capabilities: ['chat']` |
| `ai-providers:delete` | Hard-deletes Ollama provider + all its model and chain rows |
| `ai-feature-models:save` | Works unchanged — Ollama model IDs (e.g. `qwen2.5:3b`) stored in `ai_feature_models` |

---

## UI Mockup — Settings → AI → LLM Providers

```
LLM Providers
─────────────────────────────────────────────────────────

  ┌──────────────────────────────────────────────────────┐
  │  Anthropic                                         ×  │
  │  API Key: [sk-ant-••••••••••••••••••••] [👁] [Test]   │
  │                                                        │
  │  Chat models:                                          │
  │  ☑ Claude Sonnet 4.6                                   │
  │  ☑ Claude Haiku 4.5                                    │
  └──────────────────────────────────────────────────────┘

  ┌──────────────────────────────────────────────────────┐
  │  Ollama (local)                                    ×  │
  │  Base URL: [http://localhost:11434      ] [Refresh]    │
  │                                                        │
  │  Chat models:                                          │
  │  ☑ qwen2.5:3b                                          │
  │  ☑ qwen3:1.7b                                          │
  │  ☐ llama3.2:3b                                         │
  │  ☐ mistral-nemo:12b                                    │
  └──────────────────────────────────────────────────────┘

  [+ Add Provider ▾]
```

---

## Non-Goals (Phase 1)

- **Ollama embedding support** — deferred; requires variable-dimension vec0 table redesign
- **Streaming chat responses** — Ollama's OpenAI-compat endpoint supports streaming; adding it to the chat feature is a separate concern shared by all providers
- **Model installation from UI** — pulling new models (`ollama pull qwen2.5:3b`) is not done from Wizz; users manage their Ollama installation separately
- **Connection status indicator** — a persistent "Ollama online/offline" indicator in the sidebar is not added in Phase 1; connection failures surface through the standard fallback/error system in `callWithFallback`
- **Model capability auto-detection** — detecting which installed models support tool use requires probing each model; deferred; users are guided by the recommended model list

---

## Implementation Checklist

### Phase A — Adapter & Registry ✅
- [x] Create `src/main/ai/providers/ollama.ts`
  - `fetchModels(baseUrl)` — GET `${baseUrl}/api/tags`, parse model list, return `ModelDef[]` with `capabilities: ['chat']`; timeout 5 s; throw descriptive error if Ollama unreachable or no models installed
  - `chat(params, baseUrl)` — use `openai` npm package with `baseURL: baseUrl + '/v1'` and dummy `apiKey: 'ollama'`; map `ChatParams` → OpenAI format (reuse logic from `openai.ts`, omit image blocks and web search); uses `max_tokens` (not `max_completion_tokens`); map response back to `ChatResult`; handle tool use (include tools array when `params.tools` is set)
  - No `embed` method — explicitly omit so the router skips Ollama for the `embedding` slot
  - Export `OLLAMA_POPULAR_MODELS = []` (empty; models are always fetched live)
- [x] Extend `ProviderDef` in `src/main/ai/registry.ts` with optional fields: `credentialType?: 'api_key' | 'base_url'`, `credentialDefault?: string`, `credentialPlaceholder?: string`
- [x] Register `ollamaAdapter` in `PROVIDER_DEFS` in `registry.ts` with `credentialType: 'base_url'`, `credentialDefault: 'http://localhost:11434'`

### Phase B — IPC ✅
- [x] Update `ai-providers:list` handler in `src/main/db/ipc.ts` to include `credentialType`, `credentialDefault`, and `credentialPlaceholder` per-provider row (read from `getProviderDef()`)
- [x] Verify `ai-providers:fetch-models` works transparently (passes `apiKey`=base URL to `ollamaAdapter.fetchModels`) — no changes needed
- [x] Verify `ai-providers:save` stores base URL in `api_key` column correctly — no changes needed; existing handler is generic

### Phase C — Settings UI ✅
- [x] Extend `ProviderRow` interface in `SettingsModal.vue` with `credentialType?`, `credentialDefault?`, `credentialPlaceholder?`
- [x] Add `{ id: 'ollama', label: 'Ollama (local)', credentialDefault: 'http://localhost:11434' }` to `PROVIDER_OPTIONS` in `SettingsModal.vue`
- [x] Update `addProvider()` to pre-fill `apiKey` from `opt.credentialDefault`
- [x] Pass `credential-type`, `credential-default`, `credential-placeholder` props to `<AIProviderCard>` in template
- [x] Update empty-state hint to mention Ollama
- [x] `credentialType`/`credentialDefault`/`credentialPlaceholder` loaded from `ai-providers:list` response via `ProviderRow`

### Phase D — AIProviderCard adaptations ✅
- [x] Add optional props to `AIProviderCard.vue`: `credentialType`, `credentialDefault`, `credentialPlaceholder`
- [x] `onMounted`: pre-fill `localKey` with `credentialDefault` if `credentialType === 'base_url'` and `localKey` is empty
- [x] Template: when `credentialType === 'base_url'`:
  - Input `type="text"` (not `password`)
  - Show/hide toggle button hidden
  - "Refresh" button always enabled via `fetchDisabled` computed (URL is non-empty due to default)
  - Placeholder and hint text adapt to `credentialPlaceholder` prop
- [x] `fetchModels()` guard: when `credentialType === 'base_url'`, skip the `!localKey.value.trim()` early return
- [x] `.key-input--url` scoped CSS class — uses `font-family: inherit` instead of monospace

### Phase E — Validation & Error Handling ✅
- [x] In `ollamaAdapter.fetchModels`, descriptive errors for: network failure, non-200 HTTP, and no models installed
- [x] `callWithFallback` error behaviour unchanged — works as-is when Ollama is offline

### Phase F — Documentation ✅
- [x] Update `CLAUDE.md` — add Ollama to provider list; document `credentialType` extension on `ProviderDef`; document `api_key` column storing base URL; document `AIProviderCard` new props

---

## Future Work (Phase 2+)

- **Ollama embedding support**: redesign the `note_chunks` / vec0 tables to support configurable vector dimensions (not hardcoded 1536); allow Ollama embedding models (`nomic-embed-text`, `mxbai-embed-large`) as alternatives to OpenAI's `text-embedding-3-small`
- **Connection status push event**: push `ollama:status` (`online | offline`) from main to renderer on a 30-second heartbeat; render a green/red dot next to Ollama in the providers list
- **Streaming responses**: add streaming support to `ollamaAdapter.chat` and wire it to the chat sidebar's token-streaming UI (shared with future streaming for OpenAI/Gemini)
- **Model pull UI**: add a "Pull model" button to the Ollama card that runs `ollama pull <model>` via `shell.exec` and streams progress
