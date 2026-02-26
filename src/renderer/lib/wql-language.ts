import { StreamLanguage, LanguageSupport } from '@codemirror/language'
import { tags } from '@lezer/highlight'

/**
 * WQL keywords (case-insensitive in the language, upper-cased here for matching).
 * CONTAINS is also a keyword but behaves as an infix operator.
 */
const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR',
  'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'CONTAINS',
])

/**
 * CodeMirror 6 StreamLanguage tokenizer for WQL (Wizz Query Language).
 *
 * Token → @lezer/highlight tag mapping (controls theme colours):
 *   keyword      → SELECT FROM WHERE AND OR ORDER BY ASC DESC LIMIT
 *   atom         → {this}
 *   operator     → = != < > <= >= CONTAINS
 *   string       → 'single-quoted string literal'
 *   number       → integer literal
 *   variableName → identifiers (alias, entity type name, field name)
 *   punctuation  → .
 */
const wqlStreamLang = StreamLanguage.define<Record<string, never>>({
  token(stream) {
    // Skip whitespace
    if (stream.eatSpace()) return null

    // Single-line comment  -- …  (strip to end of line)
    if (stream.match('--')) {
      stream.skipToEnd()
      return null
    }

    // {this} — special self-reference token
    if (stream.match('{this}')) return tags.atom.toString()

    // Multi-char operators first, then single-char
    if (stream.match('<=') || stream.match('>=') || stream.match('!=')) {
      return tags.operator.toString()
    }
    if (stream.match('<') || stream.match('>') || stream.match('=')) {
      return tags.operator.toString()
    }

    // Dot — field separator (alias.field)
    if (stream.match('.')) return tags.punctuation.toString()

    // Single-quoted string
    if (stream.match("'")) {
      while (!stream.eol()) {
        // basic \' escape
        if (stream.peek() === '\\') { stream.next(); stream.next(); continue }
        if (stream.next() === "'") break
      }
      return tags.string.toString()
    }

    // Integer literal
    if (stream.match(/[0-9]+/)) return tags.number.toString()

    // Identifier or keyword
    if (stream.match(/[a-zA-Z_][a-zA-Z0-9_]*/)) {
      const word = stream.current().toUpperCase()
      if (KEYWORDS.has(word)) return tags.keyword.toString()
      return tags.variableName.toString()
    }

    // Unrecognised character — advance one to avoid infinite loop
    stream.next()
    return null
  },

  startState: () => ({}),
  copyState: (s) => ({ ...s }),

  // Tells CodeMirror which highlighting tag corresponds to each token string.
  // StreamLanguage maps the string returned by `token()` to a highlight class
  // via the `tokenTable` option when the string does not match a built-in name.
  // Using tag.toString() values ("keyword", "atom", etc.) means the default
  // highlight styles from @codemirror/theme-one-dark or any theme that maps
  // standard lezer tags will work out of the box.
  tokenTable: {
    [tags.keyword.toString()]: tags.keyword,
    [tags.atom.toString()]: tags.atom,
    [tags.operator.toString()]: tags.operator,
    [tags.punctuation.toString()]: tags.punctuation,
    [tags.string.toString()]: tags.string,
    [tags.number.toString()]: tags.number,
    [tags.variableName.toString()]: tags.variableName,
  },
})

/** Return a CodeMirror 6 LanguageSupport for WQL. */
export function wqlLanguage(): LanguageSupport {
  return new LanguageSupport(wqlStreamLang)
}
