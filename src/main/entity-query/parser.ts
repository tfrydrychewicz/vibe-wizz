import { Condition, Operator, QueryAST, QueryParseError } from './types'

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind =
  | 'KEYWORD'   // SELECT FROM WHERE AND OR ORDER BY ASC DESC LIMIT CONTAINS
  | 'IDENT'     // user-defined identifiers (alias, entity type name, field name)
  | 'DOT'       // .
  | 'OP'        // = != < > <= >=
  | 'THIS'      // {this}
  | 'NUMBER'    // integer literal
  | 'STRING'    // 'single-quoted string'
  | 'EOF'

interface Token {
  kind: TokenKind
  value: string
  pos: number
}

const KEYWORDS = new Set([
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR',
  'ORDER', 'BY', 'ASC', 'DESC', 'LIMIT', 'CONTAINS',
])

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0

  while (i < input.length) {
    // Whitespace
    if (/\s/.test(input[i])) { i++; continue }

    // Single-line comment  --  …  (skip to end of line)
    if (input[i] === '-' && input[i + 1] === '-') {
      while (i < input.length && input[i] !== '\n') i++
      continue
    }

    const pos = i

    // {this}
    if (input.startsWith('{this}', i)) {
      tokens.push({ kind: 'THIS', value: '{this}', pos })
      i += 6
      continue
    }

    // Operators  <=  >=  !=  <  >  =
    if (input[i] === '<' || input[i] === '>' || input[i] === '!' || input[i] === '=') {
      const two = input.slice(i, i + 2)
      if (two === '<=' || two === '>=' || two === '!=') {
        tokens.push({ kind: 'OP', value: two, pos })
        i += 2
      } else {
        tokens.push({ kind: 'OP', value: input[i], pos })
        i++
      }
      continue
    }

    // Dot
    if (input[i] === '.') {
      tokens.push({ kind: 'DOT', value: '.', pos })
      i++
      continue
    }

    // Single-quoted string
    if (input[i] === "'") {
      i++ // skip opening quote
      let str = ''
      while (i < input.length && input[i] !== "'") {
        if (input[i] === '\\' && i + 1 < input.length) {
          // basic escape: \' → '
          str += input[i + 1]
          i += 2
        } else {
          str += input[i++]
        }
      }
      if (i >= input.length) {
        throw new QueryParseError(`Unterminated string literal starting at position ${pos}`)
      }
      i++ // skip closing quote
      tokens.push({ kind: 'STRING', value: str, pos })
      continue
    }

    // Number
    if (/[0-9]/.test(input[i])) {
      let num = ''
      while (i < input.length && /[0-9]/.test(input[i])) num += input[i++]
      tokens.push({ kind: 'NUMBER', value: num, pos })
      continue
    }

    // Identifier or keyword
    if (/[a-zA-Z_]/.test(input[i])) {
      let word = ''
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) word += input[i++]
      const upper = word.toUpperCase()
      tokens.push({ kind: KEYWORDS.has(upper) ? 'KEYWORD' : 'IDENT', value: upper === 'CONTAINS' ? upper : word, pos })
      continue
    }

    throw new QueryParseError(`Unexpected character '${input[i]}' at position ${i}`)
  }

  tokens.push({ kind: 'EOF', value: '', pos: i })
  return tokens
}

// ---------------------------------------------------------------------------
// Recursive-descent parser
// ---------------------------------------------------------------------------

class Parser {
  private tokens: Token[]
  private pos = 0

  constructor(tokens: Token[]) {
    this.tokens = tokens
  }

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private advance(): Token {
    const t = this.tokens[this.pos]
    if (t.kind !== 'EOF') this.pos++
    return t
  }

  private expectKeyword(word: string): void {
    const t = this.peek()
    if (t.kind !== 'KEYWORD' || t.value.toUpperCase() !== word.toUpperCase()) {
      throw new QueryParseError(
        `Expected '${word}' but got '${t.value || 'end of input'}' at position ${t.pos}`
      )
    }
    this.advance()
  }

  private expectIdent(role: string): string {
    const t = this.peek()
    if (t.kind !== 'IDENT') {
      throw new QueryParseError(
        `Expected ${role} (identifier) but got '${t.value || 'end of input'}' at position ${t.pos}`
      )
    }
    return this.advance().value
  }

  private isKeyword(word: string): boolean {
    const t = this.peek()
    return t.kind === 'KEYWORD' && t.value.toUpperCase() === word.toUpperCase()
  }

  // condition = alias "." field operator value
  private parseCondition(alias: string): Condition {
    // alias.field
    const identOrAlias = this.expectIdent('alias or field reference')

    // If the next token is DOT, this was the alias; otherwise it might be
    // an unqualified field (we still accept it — alias is assumed).
    let field: string
    let condAlias: string
    if (this.peek().kind === 'DOT') {
      this.advance() // consume dot
      condAlias = identOrAlias
      field = this.expectIdent('field name')
    } else {
      // Unqualified field — use the query alias
      condAlias = alias
      field = identOrAlias
    }

    // operator
    const opToken = this.peek()
    if (opToken.kind !== 'OP' && !(opToken.kind === 'KEYWORD' && opToken.value === 'CONTAINS')) {
      throw new QueryParseError(
        `Expected operator (=, !=, <, >, <=, >=, CONTAINS) at position ${opToken.pos}`
      )
    }
    this.advance()
    const op = opToken.value as Operator

    // value
    const valToken = this.peek()
    let value: Condition['value']
    if (valToken.kind === 'THIS') {
      this.advance()
      value = '__this__'
    } else if (valToken.kind === 'STRING') {
      this.advance()
      value = valToken.value
    } else if (valToken.kind === 'NUMBER') {
      this.advance()
      value = parseInt(valToken.value, 10)
    } else if (valToken.kind === 'IDENT') {
      // unquoted bare word (e.g. active, done)
      this.advance()
      value = valToken.value
    } else if (valToken.kind === 'KEYWORD') {
      // keyword used as a plain value (e.g. status = 'active')
      this.advance()
      value = valToken.value.toLowerCase()
    } else {
      throw new QueryParseError(
        `Expected a value ({this}, string, number, or word) at position ${valToken.pos}`
      )
    }

    return { alias: condAlias, field, op, value }
  }

  parse(): QueryAST {
    // SELECT <alias>
    this.expectKeyword('SELECT')
    const alias = this.expectIdent('alias')

    // FROM <EntityType>
    this.expectKeyword('FROM')
    // Entity type name may be a plain IDENT or a KEYWORD that happens to match a type name
    const typeToken = this.peek()
    if (typeToken.kind !== 'IDENT' && typeToken.kind !== 'KEYWORD') {
      throw new QueryParseError(
        `Expected entity type name after FROM at position ${typeToken.pos}`
      )
    }
    this.advance()
    const entityTypeName = typeToken.value

    const conditions: Condition[] = []
    let orderBy: QueryAST['orderBy']
    let limit: number | undefined

    // Optional WHERE
    if (this.isKeyword('WHERE')) {
      this.advance()
      conditions.push(this.parseCondition(alias))

      // Additional AND conditions
      while (this.isKeyword('AND')) {
        this.advance()
        conditions.push(this.parseCondition(alias))
      }
    }

    // Optional ORDER BY
    if (this.isKeyword('ORDER')) {
      this.advance()
      this.expectKeyword('BY')

      // alias.field or just field
      const first = this.expectIdent('alias or field for ORDER BY')
      let orderField: string
      if (this.peek().kind === 'DOT') {
        this.advance()
        orderField = this.expectIdent('field name for ORDER BY')
      } else {
        orderField = first
      }

      let dir: 'ASC' | 'DESC' = 'ASC'
      if (this.isKeyword('ASC')) { this.advance() }
      else if (this.isKeyword('DESC')) { this.advance(); dir = 'DESC' }

      orderBy = { field: orderField, dir }
    }

    // Optional LIMIT
    if (this.isKeyword('LIMIT')) {
      this.advance()
      const numToken = this.peek()
      if (numToken.kind !== 'NUMBER') {
        throw new QueryParseError(
          `Expected a number after LIMIT at position ${numToken.pos}`
        )
      }
      this.advance()
      limit = parseInt(numToken.value, 10)
      if (limit <= 0) throw new QueryParseError('LIMIT must be a positive integer')
    }

    // Must be EOF
    const end = this.peek()
    if (end.kind !== 'EOF') {
      throw new QueryParseError(
        `Unexpected token '${end.value}' at position ${end.pos}`
      )
    }

    return { alias, entityTypeName, conditions, orderBy, limit }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseQuery(input: string): QueryAST {
  const tokens = tokenize(input.trim())
  return new Parser(tokens).parse()
}
