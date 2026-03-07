/**
 * HTTP page fetcher for the web search pipeline.
 * Uses native fetch (available in Node 18+ / Electron) with a browser User-Agent
 * so sites don't immediately reject the request as a bot.
 */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'

const FETCH_TIMEOUT_MS = 8_000
/** 512 KB — avoids loading giant pages and blowing through memory/CPU in jsdom. */
const MAX_BYTES = 512_000

/**
 * Fetch the HTML content of a URL.
 * Returns `null` if:
 * - the request times out (8s)
 * - the response is not HTTP 2xx
 * - the content-type is not HTML
 * - any network error occurs
 */
export async function fetchPage(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
    })

    if (!res.ok) return null

    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      return null
    }

    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    const slice = bytes.length > MAX_BYTES ? bytes.slice(0, MAX_BYTES) : bytes
    return Buffer.from(slice).toString('utf-8')
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
