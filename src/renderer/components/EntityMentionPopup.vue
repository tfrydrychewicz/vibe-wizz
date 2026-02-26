<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import LucideIcon from './LucideIcon.vue'
import type { OpenMode } from '../stores/tabStore'

type FieldDef = { name: string; type: string; options?: string[]; query?: string }
type EntityData = {
  entity: { id: string; name: string; type_id: string; fields: string }
  entityType: { id: string; name: string; icon: string; schema: string; color: string | null }
}

const props = defineProps<{
  entityId: string
  anchorRect: DOMRect
}>()

const emit = defineEmits<{
  close: []
  'open-entity': [{ entityId: string; typeId: string; mode: OpenMode }]
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

type ResolvedEntityItem = { id: string; typeId: string; name: string }
type ResolvedRef =
  | { kind: 'entity'; item: ResolvedEntityItem }
  | { kind: 'entity_list'; items: ResolvedEntityItem[] }
  | { kind: 'note'; id: string; title: string }

type FieldDisplay = {
  label: string
  plain?: string       // non-ref fields
  ref?: ResolvedRef    // ref fields (once resolved)
  loading?: boolean    // ref field still resolving
}

const data = ref<EntityData | null>(null)
const failed = ref(false)
const popupRef = ref<HTMLElement | null>(null)
// Resolved navigation data for ref fields
const resolvedRefs = ref<Record<string, ResolvedRef>>({})
// Tracks which ref fields are still loading
const loadingRefs = ref<Record<string, boolean>>({})

const POPUP_APPROX_HEIGHT = 220

const popupTop = computed(() => {
  const spaceBelow = window.innerHeight - props.anchorRect.bottom
  if (spaceBelow < POPUP_APPROX_HEIGHT + 16) {
    return Math.max(8, props.anchorRect.top - POPUP_APPROX_HEIGHT - 8)
  }
  return props.anchorRect.bottom + 8
})

const popupLeft = computed(() =>
  Math.min(props.anchorRect.left, window.innerWidth - 288)
)

const fields = computed<FieldDisplay[]>(() => {
  if (!data.value) return []
  let schemaDef: { fields: FieldDef[] } = { fields: [] }
  let values: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(data.value.entityType.schema)
    if (parsed && Array.isArray(parsed.fields)) schemaDef = parsed as { fields: FieldDef[] }
  } catch { /* ignore malformed schema */ }
  try {
    values = JSON.parse(data.value.entity.fields) as Record<string, unknown>
  } catch { /* ignore malformed fields */ }

  const isRef = (type: string) =>
    type === 'entity_ref' || type === 'entity_ref_list' || type === 'note_ref'

  return schemaDef.fields
    .filter((f) => {
      if (f.type === 'computed') {
        // Show while fetching or once resolved with results
        return !!loadingRefs.value[f.name] || resolvedRefs.value[f.name] != null
      }
      return values[f.name] != null && values[f.name] !== '' && values[f.name] !== '[]'
    })
    .map((f): FieldDisplay => {
      const label = f.name.replace(/_/g, ' ')
      if (f.type === 'computed' || isRef(f.type)) {
        const resolved = resolvedRefs.value[f.name]
        return resolved
          ? { label, ref: resolved }
          : { label, loading: !!loadingRefs.value[f.name] }
      }
      const plain = Array.isArray(values[f.name])
        ? (values[f.name] as unknown[]).filter(Boolean).join(', ')
        : String(values[f.name])
      return { label, plain }
    })
})

async function resolveRefFields(
  schemaDef: { fields: FieldDef[] },
  values: Record<string, unknown>,
): Promise<void> {
  for (const f of schemaDef.fields) {
    // Computed fields derive their value from a WQL query — no stored value needed
    if (f.type === 'computed') {
      if (!f.query) continue
      loadingRefs.value[f.name] = true
      const result = (await window.api.invoke('entities:computed-query', {
        query: f.query,
        thisId: props.entityId,
      })) as { ok: boolean; results?: { id: string; name: string; type_id: string }[] }
      loadingRefs.value[f.name] = false
      if (result.ok && result.results?.length) {
        resolvedRefs.value[f.name] = {
          kind: 'entity_list',
          items: result.results.map((r) => ({ id: r.id, typeId: r.type_id, name: r.name })),
        }
      }
      continue
    }

    const raw = values[f.name]
    if (raw == null || raw === '' || raw === '[]') continue

    if (f.type === 'entity_ref') {
      const id = String(raw)
      loadingRefs.value[f.name] = true
      const result = (await window.api.invoke('entities:get', { id })) as {
        entity: { id: string; name: string; type_id: string }
      } | null
      loadingRefs.value[f.name] = false
      if (result) {
        resolvedRefs.value[f.name] = {
          kind: 'entity',
          item: { id: result.entity.id, typeId: result.entity.type_id, name: result.entity.name },
        }
      }
    } else if (f.type === 'entity_ref_list') {
      let ids: string[] = []
      try {
        ids = Array.isArray(raw) ? (raw as string[]) : (JSON.parse(String(raw)) as string[])
      } catch { ids = [] }
      loadingRefs.value[f.name] = true
      const items: ResolvedEntityItem[] = []
      for (const id of ids) {
        const result = (await window.api.invoke('entities:get', { id })) as {
          entity: { id: string; name: string; type_id: string }
        } | null
        if (result) {
          items.push({ id: result.entity.id, typeId: result.entity.type_id, name: result.entity.name })
        }
      }
      loadingRefs.value[f.name] = false
      if (items.length) resolvedRefs.value[f.name] = { kind: 'entity_list', items }
    } else if (f.type === 'note_ref') {
      const id = String(raw)
      loadingRefs.value[f.name] = true
      const note = (await window.api.invoke('notes:get', { id })) as {
        id: string; title: string
      } | null
      loadingRefs.value[f.name] = false
      if (note) resolvedRefs.value[f.name] = { kind: 'note', id: note.id, title: note.title || 'Untitled' }
    }
  }
}

function openMode(e: MouseEvent): OpenMode {
  return (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
}

function onClickEntityItem(e: MouseEvent, item: ResolvedEntityItem): void {
  emit('open-entity', { entityId: item.id, typeId: item.typeId, mode: openMode(e) })
  emit('close')
}

function onClickNoteRef(e: MouseEvent, id: string, title: string): void {
  emit('open-note', { noteId: id, title, mode: openMode(e) })
  emit('close')
}

onMounted(async () => {
  // Attach listeners first so the popup is always dismissible
  document.addEventListener('mousedown', onOutsideClick)
  document.addEventListener('keydown', onEscKey)

  try {
    const result = await window.api.invoke('entities:get', { id: props.entityId })
    if (result) {
      data.value = result as EntityData

      // Resolve ref field display names in the background
      let schemaDef: { fields: FieldDef[] } = { fields: [] }
      let fieldValues: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(data.value.entityType.schema)
        if (parsed && Array.isArray(parsed.fields)) schemaDef = parsed as { fields: FieldDef[] }
      } catch { /* ignore */ }
      try {
        fieldValues = JSON.parse(data.value.entity.fields) as Record<string, unknown>
      } catch { /* ignore */ }
      void resolveRefFields(schemaDef, fieldValues)
    } else {
      failed.value = true
    }
  } catch (err) {
    console.error('[EntityMentionPopup] entities:get error:', err)
    failed.value = true
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutsideClick)
  document.removeEventListener('keydown', onEscKey)
})

function onOutsideClick(e: MouseEvent): void {
  if (popupRef.value && !popupRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

function onEscKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

function openEntity(e: MouseEvent): void {
  if (!data.value) return
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-entity', { entityId: props.entityId, typeId: data.value.entityType.id, mode })
  emit('close')
}
</script>

<template>
  <div
    ref="popupRef"
    class="entity-popup"
    :style="{ top: `${popupTop}px`, left: `${popupLeft}px` }"
  >
    <template v-if="data">
      <div class="entity-popup-header">
        <span class="entity-popup-icon">
          <LucideIcon :name="data.entityType.icon" :size="18" :color="data.entityType.color ?? undefined" />
        </span>
        <div class="entity-popup-titles">
          <span class="entity-popup-name">{{ data.entity.name }}</span>
          <span class="entity-popup-type">{{ data.entityType.name }}</span>
        </div>
        <button class="entity-popup-open-btn" @click="openEntity($event)">Open →</button>
      </div>
      <div v-if="fields.length" class="entity-popup-fields">
        <div v-for="field in fields" :key="field.label" class="entity-popup-field">
          <span class="entity-popup-field-label">{{ field.label }}</span>

          <!-- plain value -->
          <span v-if="field.plain != null" class="entity-popup-field-value">{{ field.plain }}</span>

          <!-- still resolving -->
          <span v-else-if="field.loading" class="entity-popup-field-value entity-popup-field-muted">…</span>

          <!-- entity_ref -->
          <button
            v-else-if="field.ref?.kind === 'entity'"
            class="entity-popup-ref-link"
            :title="`Open (Shift=new pane, Cmd=new tab)`"
            @click="onClickEntityItem($event, field.ref.item)"
          >{{ field.ref.item.name }}</button>

          <!-- entity_ref_list -->
          <span v-else-if="field.ref?.kind === 'entity_list'" class="entity-popup-ref-list">
            <button
              v-for="item in field.ref.items"
              :key="item.id"
              class="entity-popup-ref-link"
              :title="`Open (Shift=new pane, Cmd=new tab)`"
              @click="onClickEntityItem($event, item)"
            >{{ item.name }}</button>
          </span>

          <!-- note_ref -->
          <button
            v-else-if="field.ref?.kind === 'note'"
            class="entity-popup-ref-link entity-popup-ref-note"
            :title="`Open (Shift=new pane, Cmd=new tab)`"
            @click="onClickNoteRef($event, field.ref.id, field.ref.title)"
          >{{ field.ref.title }}</button>
        </div>
      </div>
    </template>
    <div v-else-if="failed" class="entity-popup-status">Entity not found</div>
    <div v-else class="entity-popup-status">Loading…</div>
  </div>
</template>

<style scoped>
.entity-popup {
  position: fixed;
  z-index: 9998;
  width: 280px;
  background: #252525;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  font-size: 13px;
}

.entity-popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--color-border);
}

.entity-popup-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.entity-popup-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entity-popup-name {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entity-popup-type {
  font-size: 11px;
  color: var(--color-text-muted);
}

.entity-popup-open-btn {
  flex-shrink: 0;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-accent);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, border-color 0.1s;
}

.entity-popup-open-btn:hover {
  background: rgba(91, 141, 239, 0.1);
  border-color: var(--color-accent);
}

.entity-popup-fields {
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 180px;
  overflow-y: auto;
}

.entity-popup-field {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.entity-popup-field-label {
  flex-shrink: 0;
  color: var(--color-text-muted);
  min-width: 64px;
  text-transform: capitalize;
}

.entity-popup-field-value {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-popup-field-muted {
  color: var(--color-text-muted);
}

.entity-popup-ref-list {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  min-width: 0;
}

.entity-popup-ref-link {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 12px;
  font-family: inherit;
  color: var(--color-accent);
  cursor: pointer;
  text-decoration: underline;
  text-decoration-color: transparent;
  transition: text-decoration-color 0.1s, opacity 0.1s;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.entity-popup-ref-link:hover {
  text-decoration-color: var(--color-accent);
}

.entity-popup-ref-note {
  color: #50c0a0;
}

.entity-popup-ref-note:hover {
  text-decoration-color: #50c0a0;
}

.entity-popup-status {
  padding: 16px 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
