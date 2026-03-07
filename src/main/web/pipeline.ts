/**
 * Web search pipeline — entry point for the `web_search` WIZZ_TOOL.
 *
 * Orchestrates: DuckDuckGo search → parallel page fetch → Readability extraction.
 * All steps degrade gracefully: a failed fetch or parse returns `content: null`
 * so the snippet from DDG is used as a fallback.
 */

import { searchDDG } from './searcher'
import { fetchPage } from './fetcher'
import { extractMarkdown } from './extractor'
import type { SearchResult } from './searcher'

export type { SearchResult }

export type WebPageResult = {
  title: string
  url: string
  /** Short DDG snippet — always present even when full page extraction fails. */
  snippet: string
  /**
   * Full extracted Markdown content of the page (up to 4000 chars).
   * `null` when the page could not be fetched or no readable content was found.
   */
  content: string | null
}

/**
 * Search the web and read the top results.
 *
 * @param query      The search query
 * @param maxResults Maximum number of pages to fetch and extract (capped at 5)
 */
export async function searchAndRead(
  query: string,
  maxResults = 3,
): Promise<WebPageResult[]> {
  const cap = Math.min(maxResults, 5)
  const searchResults = await searchDDG(query, cap)
  if (searchResults.length === 0) return []

  // Fetch and extract all pages concurrently
  return Promise.all(
    searchResults.map(async (r): Promise<WebPageResult> => {
      const html = await fetchPage(r.url)
      const content = html !== null ? extractMarkdown(html, r.url) : null
      return { ...r, content }
    }),
  )
}
