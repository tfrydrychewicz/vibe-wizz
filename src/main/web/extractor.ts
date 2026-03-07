/**
 * HTML → clean Markdown extractor for the web search pipeline.
 *
 * Pipeline:
 *   raw HTML → linkedom → @mozilla/readability (Firefox Reader Mode) → Turndown → Markdown
 *
 * linkedom replaces jsdom as the DOM environment — it is a pure CJS package and avoids the
 * ERR_REQUIRE_ESM crash caused by jsdom → html-encoding-sniffer → @exodus/bytes (ESM-only)
 * in Electron's main process.
 *
 * Readability removes ads, nav, footers, and boilerplate — returning just the article body.
 * Turndown converts the clean HTML to Markdown (models handle Markdown better than HTML).
 */

import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'

/** Maximum characters of Markdown returned per page — keeps token usage manageable. */
const MAX_CONTENT_CHARS = 4_000

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
})

// Strip elements that survive Readability but are useless in AI context
turndown.remove(['script', 'style', 'nav', 'footer', 'aside', 'figure'])

/**
 * Extract the main readable content from an HTML string and convert it to Markdown.
 * Returns `null` if Readability cannot find a readable article body.
 *
 * @param html  Raw HTML string (may be truncated)
 * @param url   The page URL (unused by linkedom/Readability at this level; retained for API consistency)
 */
export function extractMarkdown(html: string, url: string): string | null {
  try {
    const { document } = parseHTML(html)
    const article = new Readability(document as unknown as Document).parse()
    if (!article?.content) return null

    const md = turndown.turndown(article.content).trim()
    if (!md) return null

    return md.length > MAX_CONTENT_CHARS ? md.slice(0, MAX_CONTENT_CHARS) + '\n…' : md
  } catch {
    return null
  }
}
