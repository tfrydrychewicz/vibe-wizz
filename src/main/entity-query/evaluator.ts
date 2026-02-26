import type Database from 'better-sqlite3'
import { Condition, Operator, QueryAST, QueryParseError } from './types'

/** Hard cap — prevents runaway queries on large entity graphs */
const MAX_ROWS = 200

export interface EntityRef {
  id: string
  name: string
  type_id: string
}

/**
 * Execute a parsed WQL QueryAST against the database.
 *
 * @param db     - better-sqlite3 Database instance
 * @param ast    - result of parseQuery()
 * @param thisId - ID of the entity currently being displayed ({this} binding)
 * @returns      up to MAX_ROWS matching entity rows
 * @throws       QueryParseError if the entity type name cannot be resolved
 */
export function evalQuery(db: Database.Database, ast: QueryAST, thisId: string): EntityRef[] {
  // 1. Resolve entity type name → id
  const typeRow = db
    .prepare(`SELECT id FROM entity_types WHERE lower(name) = lower(?)`)
    .get(ast.entityTypeName) as { id: string } | undefined

  if (!typeRow) {
    throw new QueryParseError(`Unknown entity type: '${ast.entityTypeName}'`)
  }

  // 2. Build WHERE clause fragments
  const whereParts: string[] = [
    'e.type_id = ?',
    'e.trashed_at IS NULL',
  ]
  const params: (string | number)[] = [typeRow.id]

  for (const cond of ast.conditions) {
    const { sql, bindings } = conditionToSql(cond, thisId)
    whereParts.push(sql)
    params.push(...bindings)
  }

  // 3. Optional ORDER BY — field value via json_extract
  let orderSql = ''
  if (ast.orderBy) {
    // json_extract casts to the stored type naturally; COLLATE NOCASE for text
    orderSql = ` ORDER BY json_extract(e.fields, '$.${sqlIdent(ast.orderBy.field)}') ${ast.orderBy.dir}`
  }

  // 4. Optional LIMIT (capped at MAX_ROWS)
  const effectiveLimit = Math.min(ast.limit ?? MAX_ROWS, MAX_ROWS)
  const limitSql = ` LIMIT ?`
  params.push(effectiveLimit)

  // 5. Execute
  const sql = `
    SELECT e.id, e.name, e.type_id
    FROM   entities e
    WHERE  ${whereParts.join(' AND ')}
    ${orderSql}
    ${limitSql}
  `

  return db.prepare(sql).all(...params) as EntityRef[]
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts a single Condition to a SQL fragment + parameter bindings.
 * All values are bound — never interpolated — so there is no injection risk.
 */
function conditionToSql(
  cond: Condition,
  thisId: string,
): { sql: string; bindings: (string | number)[] } {
  const path = `json_extract(e.fields, '$.${sqlIdent(cond.field)}')`
  const boundValue = cond.value === '__this__' ? thisId : cond.value

  switch (cond.op as Operator) {
    case '=':
      return { sql: `${path} = ?`, bindings: [boundValue] }
    case '!=':
      return { sql: `${path} != ?`, bindings: [boundValue] }
    case '<':
      return { sql: `${path} < ?`, bindings: [boundValue] }
    case '>':
      return { sql: `${path} > ?`, bindings: [boundValue] }
    case '<=':
      return { sql: `${path} <= ?`, bindings: [boundValue] }
    case '>=':
      return { sql: `${path} >= ?`, bindings: [boundValue] }
    case 'CONTAINS':
      // Substring match — useful for text_list fields or plain text
      return { sql: `${path} LIKE ?`, bindings: [`%${boundValue}%`] }
  }
}

/**
 * Sanitise a field/alias name before embedding it in a json_extract path.
 *
 * WQL identifiers are already constrained by the tokenizer to ^[a-zA-Z_][a-zA-Z0-9_]+$
 * so this is a defence-in-depth check rather than the primary security boundary.
 * (All *values* are always bound via prepared-statement parameters.)
 */
function sqlIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new QueryParseError(`Invalid field name: '${name}'`)
  }
  return name
}
