/**
 * Web search module — free local search pipeline using DuckDuckGo + Readability.
 *
 * Primary entry point: `searchAndRead(query, maxResults)`
 * Returns extracted Markdown content from real web pages, no API key required.
 */

export { searchAndRead } from './pipeline'
export type { WebPageResult, SearchResult } from './pipeline'
