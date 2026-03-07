# Web Search — Free Local Search Tool for AI

## 1. Overview

Add a `web_search` WIZZ_TOOL that runs entirely in the Electron main process (Node.js), giving all AI models the ability to query the web and extract readable content for free — no API keys, no per-search billing. The tool integrates into the existing WIZZ_TOOLS / tool-use loop in `sendChatMessage`, follows the same execution pattern as every other tool, and surfaces results as citable web links in the chat UI.

**Example prompt**: *"What are the latest changes in TypeScript 5.8?"*

Current flow: AI answers from personal notes only, or (if `useWebSearch = true`) uses Anthropic's paid built-in search tool.

New flow: AI calls `web_search("TypeScript 5.8 release notes")` → main process scrapes DuckDuckGo + fetches and cleans up to 3 pages → returns structured markdown to the AI → AI synthesises with citations → chat response renders web links as clickable chips.

---

## 2. Problem

The `useWebSearch` flag already exists in `sendChatMessage` and `generateInlineContent`, and is already wired through to Anthropic's server-side web search (`webSearch: true` on the `chat()` call). However:

- **Anthropic's server search is paid** — it charges per web-search invocation and only works with Anthropic models.
- **OpenAI and Gemini models cannot use it** — the flag is Anthropic-specific; other providers ignore it.
- **There is no fallback** — if `web_search_enabled` is on but the user uses a non-Anthropic model, web search silently fails.
- **No visibility** — there is no UI indication that a web search is happening or what sources were consulted.

The goal is a **provider-agnostic, zero-cost, local web search** that works for any configured chat model and surfaces its sources in the UI.

---

## 3. Library Evaluation

| Component | Library | Cost | Notes |
|-----------|---------|------|-------|
| **Search engine** | `duck-duck-scrape` | Free | Scrapes DuckDuckGo Lite; no API key; returns title + URL + snippet; well-maintained |
| **HTTP fetch** | Native `fetch` (Node 18+) | Free | Available in Electron's Node runtime; no extra dep |
| **HTML parser** | `@mozilla/readability` + `jsdom` | Free | Firefox's Reader Mode engine — removes ads/nav, returns clean article text; same engine used by every major read-it-later app |
| **Markdown conversion** | `turndown` | Free | Converts clean HTML → Markdown; models handle Markdown better than HTML |
| **Headless browser** | ❌ Playwright / Puppeteer | Free but heavy | ~300 MB Chromium download, high RAM — excluded for v1; add as opt-in fallback in a later phase if JS-rendered pages become a recurring pain point |

### Why not Google?
Google blocks automated scraping aggressively. DuckDuckGo Lite (`https://lite.duckduckgo.com/lite/`) is tolerant of legitimate user-agent requests and has been stable for headless scraping for years.

### Why not the DuckDuckGo Instant Answers API?
`https://api.duckduckgo.com/?q=...&format=json` returns only definition boxes and topic summaries, not ranked web results. It cannot find "TypeScript 5.8 release notes".

### Why not a paid tier (Brave Search, SerpAPI)?
The feature's core value proposition is free. Paid API key support is listed under Non-Goals for Phase 1 but noted as a natural extension point.

### Evaluation of `duck-duck-scrape`
The library (`npm: duck-duck-scrape`) sends a POST to `https://lite.duckduckgo.com/lite/`, parses the HTML result table, and returns typed `SearchResult[]` (`{ title, url, description }`). It has no runtime dependencies. User-agent is set to a standard Chrome string. The package is tested and works without CAPTCHA in server-side Node.js (no browser fingerprinting expected from a Node process).

---

## 4. Design

### 4.1 Architecture

New module `src/main/web/`:

```
src/main/web/
├── searcher.ts      — DuckDuckGo scrape → SearchResult[] (title, url, snippet)
├── fetcher.ts       — HTTP GET with browser UA, timeout (8s), gzip
├── extractor.ts     — HTML → clean Markdown via Readability + jsdom + Turndown
├── pipeline.ts      — searchAndRead(query, maxResults): Promise<WebPageResult[]>
└── index.ts         — re-exports pipeline + types
```

**Types** (in `pipeline.ts`):

```typescript
export type SearchResult = {
  title: string
  url: string
  snippet: string        // 1-2 sentence summary from DDG
}

export type WebPageResult = {
  title: string
  url: string
  snippet: string        // snippet from DDG (always present)
  content: string | null // extracted Markdown from full page (null on fetch/parse failure)
}
```

#### `searcher.ts`

```typescript
import { search } from 'duck-duck-scrape'

export async function searchDDG(query: string, maxResults = 5): Promise<SearchResult[]> {
  const results = await search(query, { safeSearch: 0 })
  return results.results.slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
  }))
}
```

#### `fetcher.ts`

```typescript
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
const FETCH_TIMEOUT_MS = 8_000
const MAX_BYTES = 512_000    // 512 KB — avoids giant pages blowing memory

export async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' },
    })
    if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) return null
    const buf = await res.arrayBuffer()
    if (buf.byteLength > MAX_BYTES) return Buffer.from(buf).slice(0, MAX_BYTES).toString('utf-8')
    return Buffer.from(buf).toString('utf-8')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
```

#### `extractor.ts`

```typescript
import { JSDOM } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' })
// Strip irrelevant elements before Readability sees them
td.remove(['script', 'style', 'nav', 'footer', 'aside'])

const MAX_CONTENT_CHARS = 4_000   // ~1000 tokens — enough context without flooding

export function extractMarkdown(html: string, url: string): string | null {
  try {
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document).parse()
    if (!article?.content) return null
    const md = td.turndown(article.content).trim()
    return md.length > MAX_CONTENT_CHARS ? md.slice(0, MAX_CONTENT_CHARS) + '\n…' : md
  } catch {
    return null
  }
}
```

#### `pipeline.ts` — the entry point

```typescript
export async function searchAndRead(
  query: string,
  maxResults = 3,
): Promise<WebPageResult[]> {
  const searchResults = await searchDDG(query, maxResults)
  // Fetch + extract in parallel, capped to maxResults pages
  return Promise.all(
    searchResults.map(async (r) => {
      const html = await fetchPage(r.url)
      const content = html ? extractMarkdown(html, r.url) : null
      return { ...r, content }
    }),
  )
}
```

---

### 4.2 The `web_search` WIZZ_TOOL

The tool is added to the `WIZZ_TOOLS` array in `chat.ts` when web search is enabled (controlled by the `web_search_enabled` setting). Tools are conditionally injected — if the setting is off, the tool is not exposed to the model so it cannot call it.

**Tool definition:**

```typescript
{
  name: 'web_search',
  description:
    'Search the web for current information not available in the personal knowledge base. ' +
    'Use for: recent news, current software versions, public documentation, prices, weather, ' +
    'publicly available facts. Do NOT use for: personal notes, meetings, tasks, entities — ' +
    'those are already in the context above. ' +
    'After calling this tool, always cite the sources you used.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query — be specific and include relevant keywords.',
      },
      max_results: {
        type: 'number',
        description: 'Number of pages to fetch and read (1–5, default 3).',
      },
    },
    required: ['query'],
  },
}
```

**Execution — async special case in the tool-use loop**

`executeTool()` is currently synchronous. The `web_search` tool requires async network I/O. Rather than refactoring the entire `executeTool()` to async (which would require touching all tool handlers), `web_search` is handled **before** the `executeTool()` call in the loop, as a special case:

```typescript
// In the tool-use loop inside sendChatMessage():
for (const tc of result.toolCalls) {
  if (tc.name === 'web_search') {
    const { query, max_results } = tc.input as { query: string; max_results?: number }
    const toolResult = await executeWebSearchTool(query, max_results ?? 3)
    toolResults.push({ type: 'tool_result', toolCallId: tc.id, toolName: tc.name, content: toolResult, isError: false })
    // Push a search:performed push event so the UI can show progress
    pushToRenderer('web-search:performed', { query })
    continue
  }
  // Existing synchronous executeTool() for all other tools
  try {
    const action = executeTool(tc.name, tc.input, slugToTypeId, slugToTypeName)
    actions.push(action)
    resultContent = JSON.stringify(action.payload)
  } catch (err) { ... }
}
```

**`executeWebSearchTool()` — formats results for the model:**

```typescript
async function executeWebSearchTool(query: string, maxResults: number): Promise<string> {
  const results = await searchAndRead(query, Math.min(maxResults, 5))
  if (results.length === 0) return `No web results found for: "${query}"`

  const sections = results.map((r, i) => {
    const header = `[${i + 1}] ${r.title}\nURL: ${r.url}`
    const body = r.content ?? r.snippet
    return `${header}\n\n${body}`
  })

  return (
    `Web search results for "${query}":\n\n` +
    sections.join('\n\n---\n\n') +
    '\n\nWhen citing these sources in your response, use Markdown links: [Source Title](url)'
  )
}
```

**System prompt addendum** (appended to the existing Wizz system prompt when `web_search_enabled` is true):

```
You have access to a web_search tool for real-time information. Use it when the user asks
about current events, software versions, public documentation, or anything not in their
personal notes. Always cite sources using Markdown links: [Source Title](https://...).
```

---

### 4.3 Interaction with the Existing `useWebSearch` Flag

The existing `useWebSearch = true` path (Anthropic's built-in server tool) is **preserved unchanged** as a future premium option. The new local web search is an independent, parallel path:

| Path | Trigger | Cost | Providers |
|------|---------|------|-----------|
| Anthropic native search | `webSearch: true` on `adapter.chat()` | Paid | Anthropic only |
| **Local WIZZ_TOOL search (new)** | `web_search_enabled = 'true'` setting | **Free** | **All providers** |

When `web_search_enabled` is on, the `web_search` WIZZ_TOOL is added to the tool list. The `useWebSearch` flag passed to `adapter.chat()` is set to `false` in `sendChatMessage` (the local tool replaces the server-side one). This prevents double-billing for Anthropic users who enable local search.

---

### 4.4 Progress Feedback — `web-search:performed` Push Event

```typescript
// New push event (main → renderer)
'web-search:performed' → { query: string }
```

`ChatSidebar.vue` subscribes on mount. When the event fires during a chat turn, an inline status row appears below the "thinking" dots:

```
🔍 Searching the web for "TypeScript 5.8 release notes"...
```

The row is cleared once the final response arrives. This uses the same transient-indicator pattern as `AgentStepProgress.vue` — it is NOT an `agent:step-progress` event (which is for the multi-step agent) but a lightweight one-line indicator.

A new `WebSearchIndicator.vue` component handles this, following the same minimal-animation style as `AgentStepProgress.vue`:
- Animated pulsing globe icon (Lucide `Globe`) while searching
- Fades out when the final message is rendered
- Reused by any future surface that exposes web search to the UI

---

### 4.5 Web Citation Rendering

When the AI cites a web source, it writes a Markdown link: `[Title](https://...)`. This needs to render as a styled clickable chip in the chat, distinct from note/entity chips.

**Canonical helpers** (in `src/renderer/utils/markdown.ts`, following the Inline Reference Chip Rule):

```typescript
export const WEB_LINK_CHIP_CLASS = 'wizz-web-chip'

export function renderWebLinkChip(title: string, url: string): string {
  // Inline SVG globe icon (matches Lucide style) so no runtime icon lookup needed
  return (
    `<a href="#" class="${WEB_LINK_CHIP_CLASS}" data-web-url="${escapeHtml(url)}" ` +
    `title="${escapeHtml(url)}" target="_blank">` +
    `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>` +
    `${escapeHtml(title)}</a>`
  )
}
```

**`markdownToHtml()` extension** — markdown link pattern `[text](url)` is converted to `renderWebLinkChip(text, url)` when the URL starts with `http`. Bare https URLs are also linked.

**CSS** (in `src/renderer/style.css`, alongside existing chip classes):

```css
.wizz-web-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 8px 1px 6px;
  border-radius: 12px;
  background: var(--color-surface-raised);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 0.78rem;
  font-weight: 500;
  text-decoration: none;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.wizz-web-chip:hover {
  background: var(--color-surface-hover);
  color: var(--color-text-primary);
}
.wizz-web-chip svg {
  flex-shrink: 0;
  color: var(--color-accent-muted);
}
```

**Click delegation** (in `ChatSidebar.vue`, `TodayView.vue`, `EntityReviewPanel.vue` — wherever `v-html` is used):

```typescript
// In the existing click delegate handler (e.g. onContentClick in ChatSidebar)
const webChip = (e.target as HTMLElement).closest('[data-web-url]')
if (webChip) {
  e.preventDefault()
  const url = (webChip as HTMLElement).dataset.webUrl
  if (url) window.api.invoke('shell:open-external', url)
  return
}
```

**New IPC handler** `shell:open-external` — `{ url: string }` → `void`, calls `shell.openExternal(url)` in main process (already available via Electron's `shell` module, just needs a handler registered).

---

### 4.6 Settings Integration

**New setting key**: `web_search_enabled` (`'true' | 'false'`, default `'false'`)

**SettingsModal** — AI section, new toggle row above the LLM Providers sub-tab:

```
┌─────────────────────────────────────────────────────┐
│ 🔍 Web Search                                        │
│ Allow AI to search the web for real-time information │
│ using DuckDuckGo (free, no API key required).        │
│                                       [toggle: OFF] │
└─────────────────────────────────────────────────────┘
```

The toggle saves `web_search_enabled` via `settings:set`. When on, it also shows a small info banner:
> "Searches are performed locally via DuckDuckGo. No data is sent to any search API."

**ChatSidebar header** — a small globe icon button appears next to the model selector when `web_search_enabled` is `'true'`. It acts as a visual indicator and clicking it navigates to Settings. (It does NOT function as an on/off toggle per-session — the setting is global.)

---

### 4.7 Graceful Degradation

| Failure mode | Behavior |
|-------------|----------|
| DuckDuckGo returns no results | Tool returns `"No web results found for: '{query}'"` — AI tells user |
| Page fetch times out (8s) | That page's `content` is null; snippet from DDG is used instead |
| Page content extraction fails (JS-only SPA) | `content` is null; snippet used; no crash |
| All pages fail to extract | AI receives snippets only — still useful for basic questions |
| `duck-duck-scrape` throws (rate limit, network down) | Tool result is error string; AI informs user; no crash |

---

## 5. Data Model Changes

### No New Tables

Web search is ephemeral — results are injected into the model's context for one conversation turn and not persisted. No schema changes.

### New Settings Key

`web_search_enabled` stored via existing `settings` table + `settings:get`/`settings:set` IPC. No migration needed (new key, read with `?? 'false'` default).

---

## 6. Settings UI Changes

- **SettingsModal.vue** — AI section: new "Web Search" toggle row (above LLM Providers sub-tab) with label, description, and info banner when enabled.
- **ChatSidebar.vue** — globe icon indicator in header when web search is enabled. 

---

## 7. Non-Goals (Phase 1)

- **Paid search API support** (Brave Search, SerpAPI) — natural extension, add as a provider option in Phase 2
- **Search result caching** — results are ephemeral; caching would add complexity; defer
- **Playwright/Puppeteer** for JS-rendered pages — too heavy; add as an opt-in setting in Phase 2 if user demand exists
- **Per-conversation toggle** — web search is a global setting; per-message toggle deferred
- **Search history** — not persisted; privacy by design
- **Embedding/indexing of web results** — out of scope; web content is not stored in the knowledge base
- **Replacing Anthropic's native search** — that feature remains available; this is an additive, provider-agnostic alternative

---

## 8. Reusability

| Pattern | Implementation |
|---------|---------------|
| Web search pipeline | `src/main/web/pipeline.ts` — called by `chat.ts`; ready to be called by `dailyBrief.ts` or `postProcessor.ts` in the future |
| Web chip HTML | `renderWebLinkChip()` in `markdown.ts` — used in ChatSidebar, TodayView, EntityReviewPanel wherever `v-html` content appears |
| Web chip CSS | `.wizz-web-chip` in `style.css` — single definition |
| `shell:open-external` IPC | Reusable for any future "open in browser" affordance |
| `web-search:performed` event | `WebSearchIndicator.vue` can be dropped into any view |
| Click delegation pattern | `[data-web-url]` selector — consistent with existing `[data-entity-name]` / `[data-note-title]` pattern |

---

## 9. Implementation Checklist

### Phase A — Core Pipeline ✅

- [x] Install npm packages: `duck-duck-scrape`, `@mozilla/readability`, `jsdom`, `turndown` + their `@types/*` packages
- [x] Create `src/main/web/searcher.ts` — `searchDDG(query, maxResults): Promise<SearchResult[]>` using `duck-duck-scrape`
- [x] Create `src/main/web/fetcher.ts` — `fetchPage(url): Promise<string | null>` with 8s timeout, 512 KB cap, browser UA header
- [x] Create `src/main/web/extractor.ts` — `extractMarkdown(html, url): string | null` using Readability + jsdom + Turndown; 4000 char cap
- [x] Create `src/main/web/pipeline.ts` — `searchAndRead(query, maxResults): Promise<WebPageResult[]>` orchestrating the above in parallel; exports `WebPageResult` type
- [x] Create `src/main/web/index.ts` — re-exports `searchAndRead`, `WebPageResult`, `SearchResult`
- [x] Write unit-level type check for the pipeline (no network — mock the search result; verify extractor produces valid markdown from a sample HTML fixture)

### Phase B — WIZZ_TOOL Integration ✅

- [x] Add `web_search` tool definition to `WIZZ_TOOLS` constant in `chat.ts` — gated behind `webSearchEnabled` boolean passed from `sendChatMessage` caller
- [x] Add `webSearchEnabled` parameter to `sendChatMessage()` (read from `web_search_enabled` setting in the `chat:send` IPC handler in `ipc.ts`)
- [x] Add async `web_search` special-case handler in the tool-use loop in `sendChatMessage()` — calls `searchAndRead()`, formats results via `executeWebSearchTool()`, pushes `web-search:performed` event, continues the loop
- [x] Implement `executeWebSearchTool(query, maxResults): Promise<string>` — formats `WebPageResult[]` into the structured string returned to the model as `tool_result` content
- [x] Add web search system prompt addendum to `sendChatMessage()` when `webSearchEnabled` is true — instructs model to cite sources with Markdown links
- [x] Set `useWebSearch = false` in `adapter.chat()` call when `webSearchEnabled` is true (disable paid Anthropic search when local search is active)
- [x] Register `shell:open-external` IPC handler in `src/main/db/ipc.ts` — `{ url: string }` → calls `shell.openExternal(url)` (import `shell` from `electron`)
- [x] Expose `shell:open-external` on `window.api` in `src/preload/index.ts` — no change needed; preload already has a fully generic `invoke` passthrough that covers any channel

### Phase C — Web Citation Rendering ✅

- [x] Add `WEB_LINK_CHIP_CLASS = 'wizz-web-chip'` constant to `src/renderer/utils/markdown.ts`
- [x] Add `renderWebLinkChip(title, url): string` function to `markdown.ts` — produces chip HTML with inline SVG globe icon and `data-web-url` attribute
- [x] Extend `markdownToHtml()` / `renderInline()` in `markdown.ts` to convert `[text](http...)` Markdown links → `renderWebLinkChip(text, url)` and bare `https://...` URLs → linked chips; `renderMessage()` in `ChatSidebar.vue` also pre-processes `[label](url)` links before `marked` sees them and post-processes any `<a href>` tags `marked` emits
- [x] Add `.wizz-web-chip` CSS class to `src/renderer/style.css` (alongside `.wizz-entity-chip` / `.wizz-note-chip`)
- [x] Add `[data-web-url]` click delegate in `ChatSidebar.vue` (in the existing `v-html` click handler) → calls `window.api.invoke('shell:open-external', url)`
- [x] Add the same delegate in `TodayView.vue` and `EntityReviewPanel.vue` for consistency (any surface that renders `v-html` markdown)

### Phase D — Progress Indicator ✅

- [x] Register `web-search:performed` push channel — no explicit registration needed; `pushToRenderer` is fully generic and the preload's `window.api.on()` accepts any channel string
- [x] Create `WebSearchIndicator.vue` — one-line indicator: pulsing globe SVG + "Searching the web for '{query}'…" text with truncation at 60 chars; fade-in animation reusing existing `agent-phase-fadein` keyframe; CSS in `style.css`
- [x] Mount `WebSearchIndicator.vue` in `ChatSidebar.vue` — `webSearchQuery` ref set on `web-search:performed` push; cleared by `watch(isLoading)` when response arrives and by `send()` at turn start; rendered inside the loading bubble between the agent phase label and `AgentStepProgress`

### Phase E — Settings UI ✅

- [x] Add `web_search_enabled` key to known settings documentation in `ipc.ts` (comment block)
- [x] Add "Web Search" toggle section to `SettingsModal.vue` AI tab — loads `web_search_enabled` on mount, saves via `settings:set`; shows info banner when enabled
- [x] Add globe icon indicator to `ChatSidebar.vue` header — reads `webSearchEnabled` ref (loaded from settings on mount); clicking it emits `open-view('__settings__')` to open Settings
- [x] Load `web_search_enabled` setting in the `chat:send` IPC handler in `ipc.ts`; pass it as `webSearchEnabled` to `sendChatMessage()` (done in Phase B)

### Phase F — Electron Packaging ✅

- [x] Verify `duck-duck-scrape`, `@mozilla/readability`, `jsdom`, `turndown` are listed in `dependencies` (not `devDependencies`) in `package.json` — confirmed; also moved `@types/jsdom` and `@types/turndown` from `dependencies` → `devDependencies` (they're compile-time only)
- [x] Check `electron-builder` config: confirm native-free packages don't need `asarUnpack` — confirmed; zero `.node` native binaries found in any of the four packages; no `asarUnpack` entries needed
- [x] Run `npm run build` (electron-vite build step) — exit code 0; main bundle 370 KB, renderer 3.8 MB; bundle size well within acceptable range
- [x] Run `npm run typecheck` — only pre-existing errors (3 errors in ChatSidebar, MeetingModal, SyncedEventPopup); zero new errors introduced

### Phase G — Documentation & Cleanup ✅

- [x] Update `CLAUDE.md` — new `web_search_enabled` setting key, `web-search:performed` push event + `shell:open-external` IPC handler, `src/main/web/` pipeline module (searcher/fetcher/extractor/pipeline/index), `renderWebLinkChip` helper + `WEB_LINK_CHIP_CLASS` + `.wizz-web-chip`, `WebSearchIndicator.vue`, updated `SettingsModal`/`ChatSidebar` bullets, Inline Reference Chip Rule table extended with web chip row
- [x] Update `DESIGN.md` — Phase 8 Local Web Search checklist (Phases A–G) added after Phase 7

---

## 10. Verification Scenarios

1. **Disabled (default)**: Web search off → `web_search` not in tool list → AI never calls it → no globe icon in chat header → existing behavior unchanged
2. **Simple knowledge base question**: "What did we discuss in last Monday's 1:1?" → AI answers from notes, no web search called even when enabled
3. **Current events question**: "What's new in TypeScript 5.8?" → AI calls `web_search("TypeScript 5.8 release notes changelog")` → results returned → AI summarizes with `[Source](url)` links → links render as globe chips → clicking chip opens browser
4. **DDG returns no results**: AI calls tool, gets `"No web results found"` → AI tells user gracefully
5. **Page fetch timeout**: DDG returns 3 results; page 2 times out → page 2 uses snippet only; pages 1 and 3 have full content → AI still provides useful answer
6. **JS-only SPA page** (e.g., React app with no SSR): Readability finds nothing → `content: null` → snippet used — AI cites URL anyway
7. **Non-Anthropic model (OpenAI/Gemini)**: Web search enabled + Gemini chat model configured → `web_search` WIZZ_TOOL injected → Gemini calls the tool → local pipeline runs → Gemini cites sources — works identically to Anthropic
8. **Globe icon in ChatSidebar header**: Visible when setting is on; click opens Settings modal AI tab
9. **WebSearchIndicator**: "Searching the web for '...'" row appears during tool call; disappears when response arrives
10. **Web chip rendering in TodayView and EntityReviews**: If a daily brief or entity review ever includes web-sourced markdown links, the `.wizz-web-chip` class renders them correctly (same CSS, no duplication)
