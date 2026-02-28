<script setup lang="ts">
import { ref, reactive, computed, onMounted, defineExpose, watch } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import { entityTrashStatus } from '../stores/mentionStore'
import EntityListSortBar from './EntityListSortBar.vue'
import type { FieldOption } from './EntityListSortBar.vue'

type EntityListItem = {
  id: string
  name: string
  type_id: string
  updated_at: string
  created_at: string
  fields?: string
}

type FieldDef = {
  name: string
  label?: string
  type: string
  options?: string[]
}

type EntityListPrefs = {
  sortField: string
  sortDir: 'asc' | 'desc'
  groupField: string | null
}

const DEFAULT_PREFS: EntityListPrefs = { sortField: 'name', sortDir: 'asc', groupField: null }

const props = defineProps<{
  typeId: string
  typeName: string
  activeEntityId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  'open-new-pane': [id: string]
  'open-new-tab': [id: string]
  'new-entity': []
}>()

function onItemClick(e: MouseEvent, entityId: string): void {
  if (e.metaKey || e.ctrlKey) {
    emit('open-new-tab', entityId)
  } else if (e.shiftKey) {
    emit('open-new-pane', entityId)
  } else {
    emit('select', entityId)
  }
}

const entities = ref<EntityListItem[]>([])
const pendingTrash = ref<{ id: string; count: number } | null>(null)

// Sort/group preferences
const prefs = ref<EntityListPrefs>({ ...DEFAULT_PREFS })

// Schema-derived field options
const sortableFields = ref<FieldOption[]>([])
const groupableFields = ref<FieldOption[]>([])
// Tracks which groupable fields are entity_ref type (need ID→name resolution)
const entityRefGroupFields = ref<Set<string>>(new Set())
// Cache of resolved entity IDs → names for entity_ref grouping.
// Must be reactive (not ref) so that .set() mutations are tracked by computed().
const resolvedEntityNames = reactive(new Map<string, string>())

// ── Prefs persistence ────────────────────────────────────────────────────────

const SETTINGS_KEY = 'entity_list_prefs'

async function loadPrefs(): Promise<void> {
  try {
    const raw = (await window.api.invoke('settings:get', { key: SETTINGS_KEY })) as string | null
    if (raw) {
      const all = JSON.parse(raw) as Record<string, EntityListPrefs>
      const saved = all[props.typeId]
      if (saved) {
        // Guard: if the saved sortField no longer exists in the schema, reset to name
        const validSort = isSortFieldValid(saved.sortField)
        prefs.value = {
          sortField: validSort ? saved.sortField : 'name',
          sortDir: saved.sortDir === 'desc' ? 'desc' : 'asc',
          groupField: isGroupFieldValid(saved.groupField) ? saved.groupField : null,
        }
        return
      }
    }
  } catch {
    // corrupt JSON — fall through to defaults
  }
  prefs.value = { ...DEFAULT_PREFS }
}

async function savePrefs(): Promise<void> {
  try {
    const raw = (await window.api.invoke('settings:get', { key: SETTINGS_KEY })) as string | null
    const all: Record<string, EntityListPrefs> = raw ? JSON.parse(raw) : {}
    all[props.typeId] = { ...prefs.value }
    await window.api.invoke('settings:set', { key: SETTINGS_KEY, value: JSON.stringify(all) })
  } catch {
    // best-effort
  }
}

function isSortFieldValid(field: string): boolean {
  if (['name', 'created_at', 'updated_at'].includes(field)) return true
  return sortableFields.value.some((f) => f.name === field)
}

function isGroupFieldValid(field: string | null): boolean {
  if (!field) return true
  if (field === 'name') return true
  return groupableFields.value.some((f) => f.name === field)
}

// ── Schema loading ───────────────────────────────────────────────────────────

type EntityTypeRow = { id: string; schema: string }

async function loadSchema(): Promise<void> {
  try {
    const types = (await window.api.invoke('entity-types:list')) as EntityTypeRow[]
    const type = types.find((t) => t.id === props.typeId)
    if (!type?.schema) return
    const schema = JSON.parse(type.schema) as { fields?: FieldDef[] }
    const fields: FieldDef[] = schema.fields ?? []
    const toLabel = (name: string): string =>
      (name.charAt(0).toUpperCase() + name.slice(1)).replace(/_/g, ' ')
    const SORTABLE_TYPES = new Set(['text', 'email', 'date', 'select'])
    sortableFields.value = fields
      .filter((f) => SORTABLE_TYPES.has(f.type))
      .map((f) => ({ name: f.name, label: f.label ?? toLabel(f.name) }))
    groupableFields.value = fields
      .filter((f) => f.type === 'select' || f.type === 'entity_ref')
      .map((f) => ({ name: f.name, label: f.label ?? toLabel(f.name) }))
    entityRefGroupFields.value = new Set(
      fields.filter((f) => f.type === 'entity_ref').map((f) => f.name)
    )
  } catch {
    sortableFields.value = []
    groupableFields.value = []
  }
}

// ── Data fetching ────────────────────────────────────────────────────────────

async function refresh(): Promise<void> {
  entities.value = (await window.api.invoke('entities:list', {
    type_id: props.typeId,
    sortField: prefs.value.sortField,
    sortDir: prefs.value.sortDir,
    includeFields: !!prefs.value.groupField,
  })) as EntityListItem[]

  // Resolve entity IDs → names when grouping by an entity_ref field
  if (prefs.value.groupField && entityRefGroupFields.value.has(prefs.value.groupField)) {
    await resolveGroupEntityNames(prefs.value.groupField)
  }
}

async function resolveGroupEntityNames(fieldName: string): Promise<void> {
  const ids = new Set<string>()
  for (const e of entities.value) {
    if (!e.fields) continue
    try {
      const val = (JSON.parse(e.fields) as Record<string, unknown>)[fieldName]
      if (typeof val === 'string' && val) ids.add(val)
    } catch { /* ignore */ }
  }
  // Only fetch IDs not already cached
  await Promise.all(
    [...ids]
      .filter((id) => !resolvedEntityNames.has(id))
      .map(async (id) => {
        try {
          const result = (await window.api.invoke('entities:get', { id })) as { entity: { name: string } } | null
          if (result) resolvedEntityNames.set(id, result.entity.name)
        } catch { /* ignore */ }
      })
  )
}

// ── Grouping ─────────────────────────────────────────────────────────────────

type EntityGroup = { label: string | null; items: EntityListItem[] }

const groupedEntities = computed<EntityGroup[]>(() => {
  if (!prefs.value.groupField) {
    return [{ label: null, items: entities.value }]
  }
  const field = prefs.value.groupField
  const groups = new Map<string, EntityListItem[]>()
  for (const e of entities.value) {
    const key = getGroupKey(e, field)
    const bucket = groups.get(key) ?? []
    bucket.push(e)
    groups.set(key, bucket)
  }
  // Sort group keys alphabetically; empty string (no value) goes last
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a === '') return 1
    if (b === '') return -1
    return a.localeCompare(b)
  })
  return sorted.map(([key, items]) => ({ label: key || null, items }))
})

function getGroupKey(e: EntityListItem, field: string): string {
  if (field === 'name') {
    return e.name ? e.name[0].toUpperCase() : ''
  }
  if (!e.fields) return ''
  try {
    const parsed = JSON.parse(e.fields) as Record<string, unknown>
    const val = parsed[field]
    if (typeof val !== 'string' || !val) return ''
    // For entity_ref fields, resolve the stored ID to the referenced entity's name
    if (entityRefGroupFields.value.has(field)) {
      return resolvedEntityNames.get(val) ?? ''
    }
    return val
  } catch {
    return ''
  }
}

function groupHeader(group: EntityGroup, fieldName: string): string {
  if (group.label === null) {
    // find the label for the field
    const f = groupableFields.value.find((f) => f.name === fieldName)
    return `— No ${f?.label ?? fieldName} —`
  }
  return group.label
}

// ── Pref update handlers ─────────────────────────────────────────────────────

async function onSortFieldUpdate(field: string): Promise<void> {
  prefs.value.sortField = field
  await savePrefs()
  await refresh()
}

async function onSortDirUpdate(dir: 'asc' | 'desc'): Promise<void> {
  prefs.value.sortDir = dir
  await savePrefs()
  await refresh()
}

async function onGroupFieldUpdate(field: string | null): Promise<void> {
  prefs.value.groupField = field
  await savePrefs()
  await refresh()
}

// ── Trash ────────────────────────────────────────────────────────────────────

async function requestTrash(id: string): Promise<void> {
  const { count } = (await window.api.invoke('entities:get-mention-count', { id })) as {
    count: number
  }
  if (count > 0) {
    pendingTrash.value = { id, count }
  } else {
    await finishTrash(id)
  }
}

async function finishTrash(id: string): Promise<void> {
  pendingTrash.value = null
  await window.api.invoke('entities:delete', { id })
  entityTrashStatus.set(id, true)
  await refresh()
  if (props.activeEntityId === id) {
    emit('select', entities.value.length > 0 ? entities.value[0].id : '')
  }
}

function cancelTrash(): void {
  pendingTrash.value = null
}

// ── Date formatting ───────────────────────────────────────────────────────────

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

onMounted(async () => {
  await loadSchema()
  await loadPrefs()
  await refresh()
})

watch(
  () => props.typeId,
  async () => {
    sortableFields.value = []
    groupableFields.value = []
    entityRefGroupFields.value = new Set()
    resolvedEntityNames.clear()
    await loadSchema()
    await loadPrefs()
    await refresh()
  }
)

defineExpose({ refresh })
</script>

<template>
  <div class="note-list-pane">
    <div class="note-list-header">
      <button class="note-list-new-btn" @click="emit('new-entity')">
        <Plus :size="14" />
        New {{ typeName }}
      </button>
    </div>

    <EntityListSortBar
      :sort-field="prefs.sortField"
      :sort-dir="prefs.sortDir"
      :group-field="prefs.groupField"
      :sortable-fields="sortableFields"
      :groupable-fields="groupableFields"
      @update:sort-field="onSortFieldUpdate"
      @update:sort-dir="onSortDirUpdate"
      @update:group-field="onGroupFieldUpdate"
    />

    <div class="note-list-scroll">
      <template v-for="group in groupedEntities" :key="group.label ?? '__no-group__'">
        <!-- Group header (only when grouping is active) -->
        <div
          v-if="prefs.groupField"
          class="entity-group-header"
        >
          {{ groupHeader(group, prefs.groupField) }}
          <span class="entity-group-count">{{ group.items.length }}</span>
        </div>

        <div
          v-for="entity in group.items"
          :key="entity.id"
          class="note-list-item"
          :class="{ active: entity.id === activeEntityId, 'is-confirming': pendingTrash?.id === entity.id }"
          @click="pendingTrash?.id === entity.id ? undefined : onItemClick($event, entity.id)"
        >
          <!-- Trash confirmation overlay -->
          <template v-if="pendingTrash && pendingTrash.id === entity.id">
            <div class="trash-confirm" @click.stop>
              <span class="trash-confirm-msg">
                Mentioned in {{ pendingTrash.count }} {{ pendingTrash.count === 1 ? 'note' : 'notes' }}.
                Move to trash?
              </span>
              <div class="trash-confirm-btns">
                <button class="trash-confirm-yes" @click="finishTrash(entity.id)">Move to trash</button>
                <button class="trash-confirm-no" @click="cancelTrash">Cancel</button>
              </div>
            </div>
          </template>

          <template v-else>
            <div class="note-list-item-body">
              <div class="note-list-item-title">{{ entity.name || 'Untitled' }}</div>
              <div class="note-list-item-date">{{ formatDate(entity.updated_at) }}</div>
            </div>
            <button
              class="note-list-item-delete"
              title="Move to trash"
              @click.stop="requestTrash(entity.id)"
            >
              <Trash2 :size="13" />
            </button>
          </template>
        </div>
      </template>

      <div v-if="entities.length === 0" class="note-list-empty">
        No {{ typeName.toLowerCase() }}s yet
      </div>
    </div>
  </div>
</template>

<style scoped>
.entity-group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px 3px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-text-muted);
  user-select: none;
}

.entity-group-count {
  font-size: 10px;
  font-weight: 400;
  opacity: 0.6;
}

.note-list-item.is-confirming {
  cursor: default;
  padding: 0;
}

.trash-confirm {
  width: 100%;
  padding: 10px 10px 10px 12px;
  background: var(--color-surface);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.trash-confirm-msg {
  font-size: 12px;
  color: #f06070;
  line-height: 1.4;
}

.trash-confirm-btns {
  display: flex;
  gap: 5px;
}

.trash-confirm-yes,
.trash-confirm-no {
  font-size: 11px;
  font-family: inherit;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  flex: 1;
}

.trash-confirm-yes {
  background: rgba(240, 96, 112, 0.15);
  border: 1px solid rgba(240, 96, 112, 0.5);
  color: #f06070;
}

.trash-confirm-yes:hover {
  background: rgba(240, 96, 112, 0.25);
}

.trash-confirm-no {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.trash-confirm-no:hover {
  color: var(--color-text);
}
</style>
