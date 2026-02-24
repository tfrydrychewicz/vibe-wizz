/**
 * Text chunking for semantic search.
 * Splits note body_plain into overlapping chunks bounded at sentence boundaries.
 * Each chunk gets a contextual prefix (note title) stored in chunk_context
 * to improve embedding retrieval quality.
 */

export interface Chunk {
  text: string     // raw chunk text (stored in note_chunks.chunk_text)
  context: string  // contextual prefix + text (used for embedding, stored in note_chunks.chunk_context)
  position: number
}

const CHUNK_MAX = 1600   // ~400 tokens at 4 chars/token
const OVERLAP = 200      // ~50 tokens overlap between consecutive chunks

/**
 * Split plain text into overlapping sentence-bounded chunks.
 * Strategy:
 *   1. Split on sentence-ending punctuation followed by whitespace
 *   2. Accumulate sentences until CHUNK_MAX chars reached
 *   3. Back up ~OVERLAP chars for the start of the next chunk
 */
export function chunkText(plainText: string, noteTitle: string): Chunk[] {
  const trimmed = plainText.trim()
  if (!trimmed) return []

  // Split on sentence boundaries, keeping each sentence whole
  const sentences = trimmed
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0)

  if (sentences.length === 0) return []

  const chunks: Chunk[] = []
  let pos = 0
  let i = 0

  while (i < sentences.length) {
    let current = ''
    let j = i

    // Accumulate sentences until we hit the char limit
    while (j < sentences.length) {
      const next = current ? `${current} ${sentences[j]}` : sentences[j]
      if (next.length > CHUNK_MAX && current.length > 0) break
      current = next
      j++
    }

    if (!current) break

    const context = `Note: ${noteTitle}\n\n${current}`
    chunks.push({ text: current, context, position: pos++ })

    if (j >= sentences.length) break

    // Find overlap start: step backward from j until ~OVERLAP chars are covered
    let overlapChars = 0
    let overlapStart = j
    while (overlapStart > i && overlapChars < OVERLAP) {
      overlapStart--
      overlapChars += sentences[overlapStart].length + 1
    }

    // Advance i — ensure progress to avoid infinite loop
    i = overlapStart > i ? overlapStart : j
  }

  return chunks
}
