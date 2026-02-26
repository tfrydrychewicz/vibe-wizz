export type Operator = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'CONTAINS'

export interface Condition {
  alias: string
  field: string
  op: Operator
  /** '__this__' is the {this} placeholder — resolved to the current entity's ID at eval time */
  value: string | number | '__this__'
}

export interface QueryAST {
  alias: string
  /** Raw entity type name from the query — resolved to a DB id at eval time */
  entityTypeName: string
  conditions: Condition[]
  orderBy?: { field: string; dir: 'ASC' | 'DESC' }
  limit?: number
}

export class QueryParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryParseError'
  }
}
