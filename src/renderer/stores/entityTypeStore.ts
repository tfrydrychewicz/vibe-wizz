/**
 * Module-level entity type cache.
 *
 * Populated by App.vue after loading entity-types:list.
 * Consumed by useEntityChips to style inline entity reference chips
 * without requiring a Vue injection context.
 */

export interface CachedEntityType {
  id: string
  name: string
  icon: string
  color: string | null
}

/** typeId → EntityType */
export const entityTypeMap = new Map<string, CachedEntityType>()

/** entityId → typeId (null = entity not found) */
const entityIdTypeCache = new Map<string, string | null>()

export function registerEntityTypes(types: CachedEntityType[]): void {
  entityTypeMap.clear()
  for (const t of types) entityTypeMap.set(t.id, t)
  // Invalidate entity→type cache when types are reloaded
  entityIdTypeCache.clear()
}

export async function getEntityTypeForId(entityId: string): Promise<CachedEntityType | null> {
  if (entityIdTypeCache.has(entityId)) {
    const typeId = entityIdTypeCache.get(entityId)
    return typeId ? (entityTypeMap.get(typeId) ?? null) : null
  }
  try {
    const result = await window.api.invoke('entities:get', { id: entityId }) as
      | { entity: { type_id: string } }
      | null
    const typeId = result?.entity?.type_id ?? null
    entityIdTypeCache.set(entityId, typeId)
    return typeId ? (entityTypeMap.get(typeId) ?? null) : null
  } catch {
    entityIdTypeCache.set(entityId, null)
    return null
  }
}
