# Agentic AI — Multi-Model Workflow Orchestration

## 1. Overview

Transform Wizz's AI from a single model-call loop into a full agentic system where a single user prompt can trigger a **plan** involving multiple model calls across different capabilities — text generation, image generation, and tool execution — assembled automatically into a coherent result.

**Example prompt**: *"Create a note with a list of Shakespeare dramas and a relevant picture in the header"*

Current flow: single `chat:send` → one LLM call → tool-use loop (text only).

New flow: `chat:send` → **planner** decomposes the prompt → **executor** runs a sequence of typed steps (LLM text generation, image generation, WIZZ_TOOL calls) → results assembled and returned.

---

## 2. Problem

Today, the AI chat and inline AI can only call a single model type (chat LLM) in a tool-use loop. If a user asks for something that requires **image generation** (e.g., "add a picture of…"), the system cannot fulfil it. More broadly, prompts that require coordination between different model capabilities — text synthesis, image creation, data retrieval, entity lookup — are impossible in a single round-trip. Users must manually orchestrate multi-step workflows.

---

## 3. Library Evaluation

### Candidates Considered

| Library | Pros | Cons | Verdict |
|---------|------|------|---------|
| **Vercel AI SDK 6** | Battle-tested agent loop, multi-provider, image support | Duplicates existing provider layer, adds ~2MB dep, Anthropic-specific features (web search, document blocks) need workarounds | ❌ Too much overlap |
| **Mastra** | Comprehensive workflows, agent networks, dev studio | Massive dependency, overkill, would replace entire AI layer | ❌ Overkill |
| **LangChain.js** | Mature ecosystem, extensive tools | Heavy, opinionated, duplicates existing abstractions | ❌ Too heavy |
| **Custom (extend existing architecture)** | Builds on `callWithFallback` + `resolveChain` + provider adapters, no new deps, full control, Anthropic-specific features preserved | More code to write | ✅ **Selected** |

### Rationale

Wizz already has 80% of the infrastructure:
- `callWithFallback(slot, db, fn)` handles model routing with fallback chains
- `ProviderAdapter` abstracts Anthropic/OpenAI/Gemini with a common interface
- `WIZZ_TOOLS` + tool-use loop executes actions against the DB
- `resolveChain` reads user-configured model preferences from `ai_feature_models`

What's missing:
1. **Image generation** capability in provider adapters
2. **A planning step** that decomposes prompts into typed sub-tasks
3. **An execution engine** that runs sub-tasks calling the right model capability per step
4. **Result assembly** that feeds step outputs into subsequent steps and WIZZ_TOOLS

Building this internally avoids dependency conflicts, keeps bundle size small, and preserves full compatibility with Anthropic-specific features (web search tool, `server_tool_use`, document content blocks) that the app already relies on.

---

## 4. Design

### 4.1 Concepts

**Agent** — The top-level orchestrator that receives a user prompt and returns a complete result. It owns the plan-execute-assemble lifecycle.

**Planner** — An LLM call (using the `chat` slot) that analyzes the prompt and produces a structured **Plan**: an ordered list of typed steps. The planner receives the same context as `sendChatMessage` (calendar events, action items, entity context, etc.) so it can make informed decisions.

**Step** — A single unit of work with a declared type:

| Step Type | Model Capability | Example |
|-----------|-----------------|---------|
| `text_generation` | `chat` LLM | "Generate a markdown list of Shakespeare dramas" |
| `image_generation` | `image` model | "A Renaissance theater stage with dramatic curtains" |
| `tool_call` | `chat` LLM + WIZZ_TOOLS | "Create a note with the generated content and image" |
| `web_search` | `chat` LLM + web search | "Search the web for Shakespeare's complete works" |

**Executor** — Runs each step in order, passing outputs from earlier steps as context to later ones. Steps of independent types can optionally run in parallel (e.g., text generation and image generation can run concurrently when neither depends on the other's output).

**StepResult** — The output of a step: text content, image URL/data, or tool execution results.

### 4.2 Architecture

```
src/main/ai/
├── agent/
│   ├── planner.ts         — Prompt → Plan (ordered steps)
│   ├── executor.ts        — Plan → StepResult[] (runs steps)
│   ├── types.ts           — AgentPlan, AgentStep, StepResult, etc.
│   └── index.ts           — runAgent() top-level entry point
├── featureSlots.ts        — + image_generation slot
├── modelRouter.ts         — unchanged (already supports any slot)
├── providers/
│   ├── types.ts           — + generateImage() method on ProviderAdapter
│   ├── anthropic.ts       — unchanged (no image gen)
│   ├── openai.ts          — + generateImage() (DALL-E 3 / gpt-image-1)
│   └── gemini.ts          — + generateImage() (Imagen 3)
└── registry.ts            — unchanged
```

### 4.3 Planning

The planner uses the `chat` slot LLM with a specialized system prompt that instructs it to analyze the user's request and output a structured JSON plan.

**Planner system prompt** (simplified):

```
You are a task planner for the Wizz knowledge management app. Analyze the user's request and decompose it into an ordered list of steps.

Available step types:
- text_generation: Generate text content using an LLM. Use for writing, summarizing, listing.
- image_generation: Generate an image from a text description. Use when the user asks for a picture, illustration, diagram, etc.
- tool_call: Execute a Wizz tool (create note, calendar event, action item, etc.). Use when the user wants to create, update, or delete something in Wizz.

Rules:
- Order steps so that each step can reference outputs of earlier steps via {{step_N}} placeholders.
- If two steps are independent (neither uses the other's output), mark them as parallelizable.
- The final step should always be a tool_call if the user wants something created/changed in Wizz.
- If the request can be handled in a single LLM call with tools (no image generation needed), return a plan with a single tool_call step.

Output JSON:
{
  "steps": [
    { "id": 1, "type": "text_generation", "prompt": "...", "depends_on": [] },
    { "id": 2, "type": "image_generation", "prompt": "...", "depends_on": [] },
    { "id": 3, "type": "tool_call", "prompt": "Create a note titled '...' with {{step_1}} as body and {{step_2}} as header image", "depends_on": [1, 2] }
  ]
}
```

**Optimization — skip planning for simple prompts**: If the user's prompt doesn't require image generation or multi-step coordination (detected by a lightweight heuristic or the planner itself returning a single `tool_call` step), the agent falls through to the existing `sendChatMessage` path unchanged. This ensures zero regression for the common case.

### 4.4 Image Generation

#### Provider Adapter Extension

```typescript
// src/main/ai/providers/types.ts — new method on ProviderAdapter
export interface ProviderAdapter {
  fetchModels(apiKey: string): Promise<ModelDef[]>
  chat(params: ChatParams, apiKey: string): Promise<ChatResult>
  embed?(texts: string[], modelId: string, apiKey: string): Promise<EmbedResult[]>
  generateImage?(params: ImageGenParams, apiKey: string): Promise<ImageGenResult>
}

export interface ImageGenParams {
  model: string
  prompt: string
  size?: '1024x1024' | '1536x1024' | '1024x1536'  // landscape/portrait/square
  quality?: 'standard' | 'hd'
  style?: 'natural' | 'vivid'
}

export interface ImageGenResult {
  /** Base64-encoded image data */
  base64: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  revisedPrompt?: string
}
```

#### OpenAI Adapter — `generateImage()`

```typescript
// Uses gpt-image-1 (or dall-e-3 fallback)
async generateImage(params: ImageGenParams, apiKey: string): Promise<ImageGenResult> {
  const client = new OpenAI({ apiKey })
  const response = await client.images.generate({
    model: params.model,
    prompt: params.prompt,
    size: params.size ?? '1024x1024',
    quality: params.quality ?? 'standard',
    response_format: 'b64_json',
    n: 1,
  })
  return {
    base64: response.data[0].b64_json!,
    mimeType: 'image/png',
    revisedPrompt: response.data[0].revised_prompt,
  }
}
```

#### Gemini Adapter — `generateImage()`

Uses `imagen-3.0-generate-002` or `gemini-2.0-flash-exp` with image generation config via REST API.

#### Image Storage

Generated images are stored locally in `{userData}/generated-images/{ulid}.png` and referenced in TipTap note content as local file paths (same pattern as existing drag-and-drop images). The main process handles file I/O; the renderer receives a `file://` URL for display.

### 4.5 Feature Slot & Default Chain

```typescript
// Added to featureSlots.ts
{ id: 'image_generation', label: 'Image Generation', capability: 'image' }

// Added to DEFAULT_CHAINS
image_generation: ['gpt-image-1'],  // OpenAI default; users can switch to Imagen
```

### 4.6 Execution Flow

```
User: "Create a note with a list of Shakespeare dramas and a relevant picture in the header"
    │
    ├─ Step 0: Agent receives prompt + context
    │   Heuristic check: prompt mentions "picture/image/photo/illustration"
    │   → multi-step mode activated (skip for simple prompts)
    │
    ├─ Step 1: PLANNER (chat slot)
    │   Input: user prompt + available tools + capabilities
    │   Output: Plan {
    │     steps: [
    │       { id: 1, type: "text_generation", prompt: "List all Shakespeare dramas...", depends_on: [] },
    │       { id: 2, type: "image_generation", prompt: "Renaissance theater stage...", depends_on: [] },
    │       { id: 3, type: "tool_call", prompt: "Create note titled 'Shakespeare Dramas' with {{step_2}} as header image and {{step_1}} as body", depends_on: [1, 2] }
    │     ]
    │   }
    │
    ├─ Step 2: EXECUTOR
    │   ├─ Steps 1 & 2 have no dependencies → run in parallel
    │   │   ├─ Step 1: callWithFallback('chat', db, ...) → markdown text
    │   │   └─ Step 2: callWithFallback('image_generation', db, ...) → base64 image → saved to disk
    │   │
    │   └─ Step 3 depends on [1, 2] → runs after both complete
    │       ├─ Substitutes {{step_1}} and {{step_2}} placeholders
    │       └─ callWithFallback('chat', db, ...) with WIZZ_TOOLS
    │           → LLM calls create_note tool with the assembled content
    │
    └─ Step 3: ASSEMBLY
        ├─ Collects all ExecutedActions from tool_call steps
        ├─ Collects final text response
        └─ Returns { content, actions, entityRefs, generatedImages }
```

### 4.7 Integration Points

The agent is invoked from two existing entry points — no new IPC channels required:

| Entry Point | Current Handler | Change |
|-------------|----------------|--------|
| `chat:send` | `sendChatMessage()` | Wraps in `runAgent()` when plan has >1 step; single-step plans fall through to existing logic |
| `notes:ai-inline` | `generateInlineContent()` | Same wrap; image generation available in inline AI |

**`chat:send` response — extended type:**

```typescript
interface ChatResponse {
  content: string
  references: { id: string; title: string }[]
  actions: ExecutedAction[]
  entityRefs: { id: string; name: string }[]
  warning?: string
  generatedImages?: { path: string; prompt: string }[]  // new — images generated during the agent run
}
```

### 4.8 Progress Reporting

For multi-step plans, the agent pushes progress events to the renderer so the UI can show step-by-step status:

```typescript
// New push event
'agent:step-progress' → { stepId: number, type: StepType, status: 'running' | 'complete' | 'error', label: string }
```

**ChatSidebar UI** shows a collapsible "Agent Steps" indicator below the loading state:

```
┌──────────────────────────────────────────┐
│  ⚡ Working on your request...            │
│                                          │
│  ✅ Generated text content               │
│  🔄 Generating image...                  │
│  ⏳ Create note (waiting)                │
└──────────────────────────────────────────┘
```

### 4.9 Error Handling

- If a step fails, the executor checks if the step is critical (tool_call steps are always critical; text/image steps may have fallback behavior).
- **Image generation failure**: The agent continues without the image and mentions in the response that image generation failed (e.g., "I created the note but couldn't generate an image — no image generation model is configured. You can add one in Settings → AI Providers.").
- **Planner failure**: Falls back to the existing single-call `sendChatMessage` path.
- **Partial success**: If some steps succeed and others fail, the agent reports what was accomplished and what failed.

### 4.10 WIZZ_TOOLS Extension

The existing `WIZZ_TOOLS` are extended with one new tool for image-aware note creation:

```typescript
{
  name: 'create_note',
  description: 'Create a new note. Content should be in Markdown format.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string', description: 'Markdown content for the note body' },
      header_image_ref: { type: 'string', description: 'Reference to a generated image (e.g., {{step_2}}) to insert at the top of the note' },
    },
    required: ['title', 'content']
  }
}
```

The `executeTool` function for `create_note` resolves image references, converts the markdown to TipTap JSON (using existing `parseMarkdownToTipTap`), prepends the image node if present, and calls the same DB logic as `notes:create` + `notes:update`.

---

## 5. Data Model Changes

### New Tables

None. Image generation uses the existing `ai_providers` / `ai_models` / `ai_feature_models` tables. Generated image files are stored on disk (not in the DB).

### Migration

**Migration `0011_image_generation_slot.ts`**:
- Seeds `image_generation` feature slot into `ai_feature_models` if an OpenAI provider with an image-capable model exists
- No schema changes required

### Feature Slot Addition

```typescript
// featureSlots.ts
{ id: 'image_generation', label: 'Image Generation', capability: 'image' }
```

Added to `FEATURE_SLOTS` array and `DEFAULT_CHAINS`.

---

## 6. Settings UI Changes

### AI Providers Tab

Image-capable models already appear in the provider model list (DALL-E 3, gpt-image-1, Imagen 3) grouped under an **Image** capability heading. No UI changes needed — the existing `AIProviderCard.vue` already groups by capability.

### AI Features Tab

A new row appears for `Image Generation` in `FeatureChainEditor.vue`. Only models with `capability: 'image'` are shown in the dropdown. Works identically to existing feature slots.

---

## 7. Reusability

The agent orchestrator is designed to be reusable across all AI entry points:

| Surface | Usage |
|---------|-------|
| **AI Chat** (`ChatSidebar`) | Full agent with progress reporting |
| **Inline AI** (`AIPromptModal`) | Agent for image-aware content generation |
| **Daily Brief** | Future: agent could generate briefs with charts/diagrams |
| **Entity Reviews** | Future: reviews with generated visualizations |

The `runAgent()` function accepts the same context shape as `sendChatMessage`, making it a drop-in wrapper.

---

## 8. Non-Goals (out of scope)

- **Video generation** — different complexity tier, deferred
- **Voice generation (TTS)** — separate feature
- **Multi-turn agent planning** — the planner runs once per prompt; iterative re-planning is deferred
- **Custom user-defined tools** — tools are hardcoded in WIZZ_TOOLS
- **Streaming responses during agent execution** — steps report progress but don't stream partial text (existing streaming in `sendChatMessage` is preserved for single-step prompts)

---

## 9. Implementation Checklist

### Phase A — Image Generation Capability ✅

- [x] Extend `ProviderAdapter` interface in `src/main/ai/providers/types.ts` with `generateImage?()` method, `ImageGenParams`, `ImageGenResult` types
- [x] Implement `generateImage()` in `src/main/ai/providers/openai.ts` (gpt-image-1 / dall-e-3)
- [x] Implement `generateImage()` in `src/main/ai/providers/gemini.ts` (imagen-3.0-generate-002 + gemini-2.0-flash-exp-image-generation)
- [x] Add `'image'` to `ModelCapability` type in `featureSlots.ts` (was already in `ModelDef.capabilities`)
- [x] Add `image_generation` feature slot to `featureSlots.ts` (`FEATURE_SLOTS` + `DEFAULT_CHAINS`)
- [x] Create migration `0013_image_generation_slot.ts` — seed feature chain from existing image-capable models
- [x] Add image storage utility: `src/main/ai/imageStorage.ts` — `saveGeneratedImage(base64, mimeType) → filePath`
- [x] Update `FeatureChainEditor.vue` and `SettingsModal.vue` capability types to include `'image'`
- [x] Verify image models appear correctly in Settings → AI Providers (grouped under "Image") and AI Features — typecheck passes

### Phase B — Agent Types & Planner ✅

- [x] Create `src/main/ai/agent/types.ts` — `AgentPlan`, `AgentStep`, `StepType`, `StepResult`, `StepProgress`, `AgentContext`, `AgentResult`, `GeneratedImage`
- [x] Create `src/main/ai/agent/planner.ts` — `planPrompt(userPrompt, db): Promise<AgentPlan>`
  - Uses `callWithFallback('chat', db, ...)` with planning system prompt and few-shot examples
  - Parses structured JSON response into `AgentPlan` (strips markdown fences if present)
  - Validates step types, dependencies, and duplicate IDs
  - DAG cycle detection via Kahn's topological sort
  - `needsAgentPlanning(prompt, db)` heuristic: regex for image-related keywords + checks if `image_generation` chain has models
  - Plans with a single `tool_call` step set `singleStepPassthrough = true` for executor fast-path
- [x] Create `src/main/ai/agent/index.ts` — re-exports all types and planner functions

### Phase C — Agent Executor ✅

- [x] Create `src/main/ai/agent/executor.ts` — `executeAgentPlan(plan, context, db): Promise<AgentResult>`
  - Topological layer sort via Kahn's algorithm — groups steps into layers where each layer's steps can run in parallel
  - Runs independent steps in parallel within each layer (`Promise.all`)
  - Substitutes `{{step_N}}` placeholders in step prompts with previous step results (text, image path, or tool response)
  - `text_generation` steps: `callWithFallback('chat', db, ...)` with clean writing-assistant system prompt
  - `image_generation` steps: `callWithFallback('image_generation', db, ...)` → `saveGeneratedImage()` to disk
  - `tool_call` steps: delegates to `sendChatMessage()` with full context (preserves existing tool-use loop, entity tools, system prompt)
  - Pushes `agent:step-progress` events to renderer via `pushToRenderer()` for each step (pending → running → complete/error)
  - Collects `ExecutedAction[]`, `entityRefs`, and `generatedImages[]` across all steps
  - Graceful degradation: image step failure → continues with empty path, adds warning to response text
  - Per-step timeouts: 30s text, 60s image, 60s tool_call
  - Final content: uses last tool_call text if present, otherwise concatenates text_generation outputs
- [x] Re-exported `executeAgentPlan` from `src/main/ai/agent/index.ts`

### Phase D — Integration with `chat:send` ✅

- [x] Create `src/main/ai/agent/runAgent.ts` — `runAgent(context, db): Promise<AgentResult>`
  - Top-level entry: classify → plan → execute
  - Single-step plans and non-image prompts bypass executor and call existing `sendChatMessage` directly
  - Planning failures gracefully degrade to `sendChatMessage`
  - Returns the same shape as `ChatResponse` with added `generatedImages` field
- [x] Refactor `chat:send` handler in `src/main/db/ipc.ts`:
  - Route through `runAgent()` instead of directly calling `sendChatMessage()`
  - All context-gathering (FTS5, Graph RAG, calendar, action items, entities) remains in `ipc.ts`
  - `runAgent` handles the decision of single-step vs multi-step internally
- [x] Re-exported `runAgent` from `src/main/ai/agent/index.ts`
- [x] `agent:step-progress` push event works via existing generic `pushToRenderer` + preload `on()` — no registration needed (both accept any channel string)

### Phase E — Integration with Inline AI ✅

- [x] Updated `notes:ai-inline` handler in `ipc.ts`:
  - Calls `needsAgentPlanning()` to classify the prompt
  - When image generation needed: runs `generateInlineContent()` and `planPrompt()` in parallel
  - Extracts `image_generation` steps from the plan and executes them via `callWithFallback('image_generation', ...)`
  - Images saved to disk via `saveGeneratedImage()` AND returned as data URLs
  - Handler return type extended to `{ content, generatedImages? }`
- [x] `NoteEditor.vue` — handles `generatedImages` in the inline AI response:
  - Builds TipTap image nodes from `generatedImages` data URLs
  - Prepends image nodes before text content so images appear as a header
  - Combined content inserted at cursor position via existing `insertContentAt` flow

### Phase F — ChatSidebar Progress UI ✅

- [x] Add `agent:step-progress` listener in `ChatSidebar.vue`
  - Subscribes via `window.api.on('agent:step-progress', ...)` on mount, unsubscribes on unmount
  - Upserts steps by `stepId` into reactive `agentSteps` array
  - Clears steps on send start and in finally block
- [x] Created `AgentStepProgress.vue` component with elegant animated SVG status icons:
  - **Pending**: hollow circle (muted)
  - **Running**: animated spinner ring (accent color, smooth 0.8s rotation)
  - **Complete**: filled circle + checkmark with draw-in animation (green)
  - **Error**: filled circle + X mark (red)
  - Collapsible step list with chevron toggle and completion counter
  - Step type badges (T = text, I = image, F = tool/function) colored by status
- [x] Progress panel shown below the typing dots indicator during multi-step agent runs
- [x] Progress panel hidden (steps cleared) when agent completes and final response is shown
- [x] Generated images displayed inline in chat response:
  - `generatedImages` field added to `ChatMessage` type and `chatStore.ts`
  - `chat:send` handler passes `generatedImages` from `runAgent` result through to renderer
  - Registered `wizz-file://` custom protocol in `index.ts` (scoped to `generated-images/` dir for security)
  - Images rendered as thumbnails with hover border effect; `title` shows the generation prompt
- [x] All styles in global `style.css` using shared CSS variable patterns

### Phase G — WIZZ_TOOLS Extension ✅

- [x] Updated `create_note` tool schema and description
  - Removed rigid `header_image_path` parameter — images can now go anywhere
  - Description instructs the LLM to use `![description](file_path)` at the desired position in markdown content
  - Content field description also updated with image placement guidance
- [x] Created `resolveLocalImages()` helper in `chat.ts`
  - Recursively walks TipTap node tree; converts image nodes with local file paths to embedded data URLs
  - Strips `[Generated image saved at: ...]` wrappers from `{{step_N}}` substitution
  - Validates file existence via `existsSync`, reads with `readFileSync`, determines MIME from extension
  - Graceful: leaves `src` unchanged on read failure
  - Called by `create_note` tool handler after `parseMarkdownToTipTap` — images at any position are resolved
- [x] Added `![alt](src)` image markdown support to `parseMarkdownToTipTap`
  - Block-level pattern: standalone `![alt](src)` lines become `{ type: 'image', attrs: { src, alt } }` nodes
  - Paragraph collector updated to break on `![` lines so images aren't swallowed into paragraphs

### Phase H — Error Handling & Edge Cases ✅

- [x] "No image generation model configured" — handled at two levels:
  - `needsAgentPlanning()` returns `false` immediately when `resolveChain('image_generation')` is empty → no agent overhead
  - Executor catches `callWithFallback` failures and surfaces actionable warning: "Open **Settings → AI Providers** to add one"
- [x] Image generation API errors — retry once (2s delay), then skip with contextual warning:
  - `executeImageGeneration` retries once on any failure before re-throwing
  - Executor catches and produces actionable messages for: content policy blocks, rate limits/429, timeouts, generic errors
  - Image step failure is non-fatal — plan continues without the image, warning appended to response
- [x] Planner returning invalid JSON — `planPrompt()` throws, `runAgent()` catches and falls back to `sendChatMessage` (no agent overhead, existing behavior preserved)
- [x] Circular dependencies in plan steps — `validatePlan()` runs Kahn's algorithm for cycle detection; throws on cycle, `runAgent()` falls back
- [x] Timeout per step — `STEP_TIMEOUT_MS`: 30s text, 60s image, 60s tool_call; enforced via `withTimeout` wrapper
- [x] `callWithFallback` works generically with `image_generation` slot — resolves configured models, tries each in chain order, re-throws AggregateError only when all fail

### Phase I — Documentation & Cleanup

- [ ] Update `CLAUDE.md` with new modules, IPC events, feature slot, agent architecture
- [ ] Update `DESIGN.md` with new phase checklist
- [ ] Run `npm run typecheck` — zero errors
- [ ] Manual verification of all scenarios in §10

---

## 10. Verification Scenarios

1. **Simple chat (no regression)**: "What did we discuss about the migration?" → existing flow, no planner, instant response
2. **Image-only request**: "Generate a picture of a sunset over mountains" → planner creates 1 image step → image returned in chat
3. **Text + image + note creation**: "Create a note with a list of Shakespeare dramas and a relevant picture in the header" → 3-step plan (text, image, tool_call) → note created with image and text
4. **No image model configured**: Same prompt as #3 → planner still creates plan → image step fails gracefully → note created without image, warning shown
5. **Inline AI with image**: Select text, press AI bubble, prompt "Replace with a summary and add an illustration" → inline agent generates text + image → both inserted
6. **Single-step optimization**: "Schedule a meeting for Friday at 3pm" → planner returns single tool_call step → falls through to existing sendChatMessage → zero latency overhead
7. **Parallel execution**: Steps 1 (text) and 2 (image) run concurrently → total time ≈ max(text_time, image_time), not sum
8. **Progress reporting**: During multi-step execution, ChatSidebar shows step-by-step progress with status icons
