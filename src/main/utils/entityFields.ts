/**
 * Shared helpers for working with entity field values stored in the DB.
 */

/**
 * Extract flat alias strings from a single entity field value.
 * Handles plain strings, JSON arrays, and comma/newline-delimited text
 * (all storage formats used by text, email, and text_list fields).
 */
export function extractFieldAliases(rawValue: unknown): string[] {
  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim()
    if (!trimmed) return []
    // text_list may be stored as a JSON array
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        return parsed.flatMap((v) => (typeof v === 'string' && v.trim() ? [v.trim()] : []))
      }
    } catch { /* not JSON — treat as plain string */ }
    // Comma- or newline-delimited fallback
    return trimmed
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (Array.isArray(rawValue)) {
    return rawValue.flatMap((v) => (typeof v === 'string' && v.trim() ? [v.trim()] : []))
  }
  return []
}

/**
 * Given an entity's raw `fields` JSON string and its type schema JSON string,
 * return all alias strings from fields that have `ner_search: true`.
 */
export function getEntityNerAliases(fieldsJson: string | null, schemaJson: string): string[] {
  let nerFieldNames: string[] = []
  try {
    const schema = JSON.parse(schemaJson) as { fields?: { name: string; ner_search?: boolean }[] }
    nerFieldNames = (schema.fields ?? [])
      .filter((f) => f.ner_search === true)
      .map((f) => f.name)
  } catch { return [] }

  if (!nerFieldNames.length) return []

  let fieldData: Record<string, unknown> = {}
  try { fieldData = JSON.parse(fieldsJson ?? '{}') as Record<string, unknown> } catch { /* */ }

  return nerFieldNames.flatMap((fieldName) => extractFieldAliases(fieldData[fieldName]))
}
