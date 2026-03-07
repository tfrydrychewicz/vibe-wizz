/**
 * DuckDuckGo web search — free, no API key required.
 *
 * Directly fetches DuckDuckGo Lite HTML (`html.duckduckgo.com`) with browser-like headers
 * and parses results with linkedom. This avoids the `duck-duck-scrape` library's VQD-token
 * flow which reliably triggers DDG's anti-bot "anomaly detected" block in Electron.
 */

import { parseHTML } from 'linkedom'

export type SearchResult = {
  title: string
  url: string
  /** Short description / snippet from DDG. */
  snippet: string
}

const DDG_LITE_URL = 'https://html.duckduckgo.com/html/'

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
}

/**
 * Decode the DDG redirect href (`//duckduckgo.com/l/?uddg=ENCODED_URL&rut=...`) into
 * the actual destination URL string. Returns `null` if the href is not a DDG redirect.
 */
function decodeResultUrl(href: string | null): string | null {
  if (!href) return null
  try {
    // DDG encodes links as protocol-relative redirect URLs
    const normalized = href.startsWith('//') ? `https:${href}` : href
    const uddg = new URL(normalized).searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : null
  } catch {
    return null
  }
}

/**
 * Search DuckDuckGo and return up to `maxResults` web results.
 * Returns an empty array on network failure — callers should handle gracefully.
 */
export async function searchDDG(query: string, maxResults = 5): Promise<SearchResult[]> {
  try {
    const url = `${DDG_LITE_URL}?q=${encodeURIComponent(query)}`
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return []

    const html = await res.text()
    const { document } = parseHTML(html)

    const items: SearchResult[] = []
    for (const el of Array.from(document.querySelectorAll('.result'))) {
      const titleEl = el.querySelector('a.result__a')
      const snippetEl = el.querySelector('.result__snippet')

      const title = titleEl?.textContent?.trim() ?? ''
      const href = titleEl?.getAttribute('href') ?? null
      const url = decodeResultUrl(href)
      const snippet = snippetEl?.textContent?.trim() ?? ''

      if (url && title) {
        items.push({ title, url, snippet })
        if (items.length >= maxResults) break
      }
    }

    return items
  } catch {
    return []
  }
}
