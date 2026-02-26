<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { Trash2, X, ExternalLink } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'
import { entityTrashStatus } from '../stores/mentionStore'
import { activePane } from '../stores/tabStore'
import type { OpenMode } from '../stores/tabStore'

type FieldDef = {
  name: string
  type:
    | 'text'
    | 'email'
    | 'date'
    | 'select'
    | 'text_list'
    | 'entity_ref'
    | 'entity_ref_list'
    | 'note_ref'
  options?: string[]
  entity_type?: string
}

type EntitySchema = {
  fields: FieldDef[]
}

type EntityTypeRow = {
  id: string
  name: string
  icon: string
  schema: string
  color: string | null
}

type EntityRow = {
  id: string
  name: string
  type_id: string
  fields: string
}

type RefEntityData = { id: string; name: string; type_id: string }
type RefNoteData = { id: string; title: string }

const props = defineProps<{ entityId: string }>()
const emit = defineEmits<{
  saved: [name: string]
  loaded: [name: string]
  trashed: [entityId: string]
  'open-entity': [{ entityId: string; typeId: string; mode: OpenMode }]
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

const nameInputRef = ref<HTMLInputElement | null>(null)
const entityName = ref('')
const fieldValues = ref<Record<string, string>>({})
const schema = ref<EntitySchema>({ fields: [] })
const entityType = ref<EntityTypeRow | null>(null)
const saveStatus = ref<'' | 'saving' | 'saved'>('')
const isLoading = ref(false)

// Ref field resolved display data
const refEntityMap = ref<Record<string, RefEntityData | null>>({})
const refEntityListMap = ref<Record<string, RefEntityData[]>>({})
const refNoteMap = ref<Record<string, RefNoteData | null>>({})

// Per-field search state
const refSearch = ref<Record<string, string>>({})
const refResults = ref<Record<string, (RefEntityData | RefNoteData)[]>>({})
const refSearchOpen = ref<Record<string, boolean>>({})

// Entity type lookup: id→{id,name} and lowercase-name→{id,name}
const entityTypeLookup = ref<Record<string, { id: string; name: string }>>({})

async function loadEntityTypes(): Promise<void> {
  const types = (await window.api.invoke('entity-types:list')) as EntityTypeRow[]
  const lookup: Record<string, { id: string; name: string }> = {}
  for (const t of types) {
    lookup[t.id] = { id: t.id, name: t.name }
    lookup[t.name.toLowerCase()] = { id: t.id, name: t.name }
  }
  entityTypeLookup.value = lookup
}

function resolveEntityTypeId(entityType: string | undefined): string | undefined {
  if (!entityType) return undefined
  return entityTypeLookup.value[entityType]?.id ?? entityTypeLookup.value[entityType.toLowerCase()]?.id
}

async function resolveRefFields(): Promise<void> {
  for (const field of schema.value.fields) {
    const val = fieldValues.value[field.name]

    if (field.type === 'entity_ref') {
      if (val) {
        const result = (await window.api.invoke('entities:get', { id: val })) as {
          entity: EntityRow
          entityType: EntityTypeRow
        } | null
        if (result) {
          refEntityMap.value[field.name] = {
            id: result.entity.id,
            name: result.entity.name,
            type_id: result.entity.type_id,
          }
        } else {
          refEntityMap.value[field.name] = null
        }
      } else {
        refEntityMap.value[field.name] = null
      }
    } else if (field.type === 'entity_ref_list') {
      let ids: string[] = []
      try {
        ids = JSON.parse(val || '[]') as string[]
      } catch {
        ids = []
      }
      const resolved: RefEntityData[] = []
      for (const id of ids) {
        const result = (await window.api.invoke('entities:get', { id })) as {
          entity: EntityRow
          entityType: EntityTypeRow
        } | null
        if (result) {
          resolved.push({ id, name: result.entity.name, type_id: result.entity.type_id })
        }
      }
      refEntityListMap.value[field.name] = resolved
    } else if (field.type === 'note_ref') {
      if (val) {
        const note = (await window.api.invoke('notes:get', { id: val })) as {
          id: string
          title: string
        } | null
        refNoteMap.value[field.name] = note
          ? { id: note.id, title: note.title || 'Untitled' }
          : null
      } else {
        refNoteMap.value[field.name] = null
      }
    }
  }
}

async function loadEntity(id: string): Promise<void> {
  isLoading.value = true
  // Reset ref state
  refEntityMap.value = {}
  refEntityListMap.value = {}
  refNoteMap.value = {}
  refSearch.value = {}
  refResults.value = {}
  refSearchOpen.value = {}

  const result = (await window.api.invoke('entities:get', { id })) as {
    entity: EntityRow
    entityType: EntityTypeRow
  } | null
  if (!result) {
    isLoading.value = false
    return
  }
  entityType.value = result.entityType

  try {
    schema.value = JSON.parse(result.entityType.schema) as EntitySchema
  } catch {
    schema.value = { fields: [] }
  }

  entityName.value = result.entity.name

  let parsedFields: Record<string, unknown> = {}
  try {
    parsedFields = JSON.parse(result.entity.fields) as Record<string, unknown>
  } catch {
    // ignore malformed fields
  }

  // Initialise fieldValues from stored fields
  const values: Record<string, string> = {}
  for (const field of schema.value.fields) {
    const stored = parsedFields[field.name]
    if (field.type === 'entity_ref_list') {
      // Store as JSON array string
      if (Array.isArray(stored)) {
        values[field.name] = JSON.stringify(stored)
      } else {
        values[field.name] = stored != null && String(stored) !== '' ? String(stored) : '[]'
      }
    } else {
      values[field.name] = stored != null ? String(stored) : ''
    }
  }
  fieldValues.value = values
  isLoading.value = false
  emit('loaded', entityName.value || 'Untitled')
  if (entityName.value === 'Untitled') {
    await nextTick()
    nameInputRef.value?.focus()
    nameInputRef.value?.select()
  }

  // Resolve display data for ref fields
  await resolveRefFields()
}

async function save(): Promise<void> {
  if (isLoading.value) return
  saveStatus.value = 'saving'
  const fields: Record<string, unknown> = {}
  for (const field of schema.value.fields) {
    if (field.type === 'entity_ref_list') {
      try {
        fields[field.name] = JSON.parse(fieldValues.value[field.name] || '[]')
      } catch {
        fields[field.name] = []
      }
    } else {
      fields[field.name] = fieldValues.value[field.name] ?? ''
    }
  }
  await window.api.invoke('entities:update', {
    id: props.entityId,
    name: entityName.value,
    fields,
  })
  saveStatus.value = 'saved'
  emit('saved', entityName.value || 'Untitled')
  setTimeout(() => {
    saveStatus.value = ''
  }, 1500)
}

// ── Ref field search ─────────────────────────────────────────────────────────

async function searchEntityRef(fieldName: string, entityType: string | undefined): Promise<void> {
  const q = refSearch.value[fieldName] ?? ''
  const typeId = resolveEntityTypeId(entityType)
  const results = (await window.api.invoke('entities:search', {
    query: q,
    ...(typeId ? { type_id: typeId } : {}),
  })) as RefEntityData[]
  refResults.value[fieldName] = results
  refSearchOpen.value[fieldName] = true
}

async function searchNoteRef(fieldName: string): Promise<void> {
  const q = refSearch.value[fieldName] ?? ''
  const results = (await window.api.invoke('notes:search', { query: q })) as {
    id: string
    title: string
  }[]
  refResults.value[fieldName] = results.map((n) => ({ id: n.id, title: n.title }))
  refSearchOpen.value[fieldName] = true
}

function closeSearch(fieldName: string): void {
  refSearchOpen.value[fieldName] = false
}

// entity_ref: select single entity
function selectEntityRef(fieldName: string, entity: RefEntityData): void {
  fieldValues.value[fieldName] = entity.id
  refEntityMap.value[fieldName] = entity
  refSearch.value[fieldName] = ''
  refSearchOpen.value[fieldName] = false
}

function clearEntityRef(fieldName: string): void {
  fieldValues.value[fieldName] = ''
  refEntityMap.value[fieldName] = null
}

// entity_ref_list: add/remove entities
function addEntityToList(fieldName: string, entity: RefEntityData): void {
  const current = refEntityListMap.value[fieldName] ?? []
  if (current.find((e) => e.id === entity.id)) {
    refSearch.value[fieldName] = ''
    refSearchOpen.value[fieldName] = false
    return
  }
  refEntityListMap.value[fieldName] = [...current, entity]
  let ids: string[] = []
  try {
    ids = JSON.parse(fieldValues.value[fieldName] || '[]') as string[]
  } catch {
    ids = []
  }
  if (!ids.includes(entity.id)) ids.push(entity.id)
  fieldValues.value[fieldName] = JSON.stringify(ids)
  refSearch.value[fieldName] = ''
  refSearchOpen.value[fieldName] = false
}

function removeEntityFromList(fieldName: string, entityId: string): void {
  refEntityListMap.value[fieldName] = (refEntityListMap.value[fieldName] ?? []).filter(
    (e) => e.id !== entityId,
  )
  let ids: string[] = []
  try {
    ids = JSON.parse(fieldValues.value[fieldName] || '[]') as string[]
  } catch {
    ids = []
  }
  fieldValues.value[fieldName] = JSON.stringify(ids.filter((id) => id !== entityId))
}

// note_ref: select single note
function selectNoteRef(fieldName: string, note: RefNoteData): void {
  fieldValues.value[fieldName] = note.id
  refNoteMap.value[fieldName] = note
  refSearch.value[fieldName] = ''
  refSearchOpen.value[fieldName] = false
}

function clearNoteRef(fieldName: string): void {
  fieldValues.value[fieldName] = ''
  refNoteMap.value[fieldName] = null
}

// ── Open handlers ────────────────────────────────────────────────────────────

function openEntityRef(e: MouseEvent, fieldName: string): void {
  const data = refEntityMap.value[fieldName]
  if (!data) return
  const mode: OpenMode = e.metaKey || e.ctrlKey ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-entity', { entityId: data.id, typeId: data.type_id, mode })
}

function openEntityFromList(e: MouseEvent, entity: RefEntityData): void {
  const mode: OpenMode = e.metaKey || e.ctrlKey ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-entity', { entityId: entity.id, typeId: entity.type_id, mode })
}

function openNoteRef(e: MouseEvent, fieldName: string): void {
  const data = refNoteMap.value[fieldName]
  if (!data) return
  const mode: OpenMode = e.metaKey || e.ctrlKey ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: data.id, title: data.title, mode })
}

// ── Trash ────────────────────────────────────────────────────────────────────

const trashMentionCount = ref<number | null>(null)
const isTrashing = ref(false)

async function requestTrash(): Promise<void> {
  const { count } = (await window.api.invoke('entities:get-mention-count', {
    id: props.entityId,
  })) as { count: number }
  if (count > 0) {
    trashMentionCount.value = count
  } else {
    await finishTrash()
  }
}

async function finishTrash(): Promise<void> {
  isTrashing.value = true
  trashMentionCount.value = null
  await window.api.invoke('entities:delete', { id: props.entityId })
  entityTrashStatus.set(props.entityId, true)
  isTrashing.value = false
  emit('trashed', props.entityId)
}

function cancelTrash(): void {
  trashMentionCount.value = null
}

function fieldLabel(name: string): string {
  return name.replace(/_/g, ' ')
}

function onKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    if (activePane.value?.type === 'entity' && activePane.value?.contentId === props.entityId) {
      e.preventDefault()
      void save()
    }
  }
}

onMounted(async () => {
  await loadEntityTypes()
  await loadEntity(props.entityId)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

watch(() => props.entityId, async (id) => {
  await loadEntity(id)
})
</script>

<template>
  <div class="entity-detail">
    <div v-if="isLoading" class="entity-detail-loading">Loading…</div>

    <template v-else>
      <div class="entity-detail-header">
        <div
          v-if="entityType"
          class="entity-type-badge"
          :style="entityType.color ? { borderColor: entityType.color, color: entityType.color } : {}"
        >
          <LucideIcon :name="entityType.icon" :size="12" :color="entityType.color ?? undefined" />
          {{ entityType.name }}
        </div>
        <div class="entity-detail-save-row">
          <span class="entity-save-status">{{ saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Saved' : '' }}</span>

          <!-- Trash confirmation inline -->
          <template v-if="trashMentionCount !== null">
            <span class="entity-trash-confirm-msg">
              Mentioned in {{ trashMentionCount }} {{ trashMentionCount === 1 ? 'note' : 'notes' }}. Move to trash?
            </span>
            <button class="btn-trash-confirm" @click="finishTrash">Trash</button>
            <button class="btn-secondary" @click="cancelTrash">Cancel</button>
          </template>

          <template v-else>
            <button class="btn-trash" :disabled="isTrashing" title="Move to trash" @click="requestTrash">
              <Trash2 :size="13" />
            </button>
            <button class="btn-primary" @click="save">Save</button>
          </template>
        </div>
      </div>

      <div class="entity-detail-body">
        <!-- Name field (always present) -->
        <div class="entity-field-row">
          <label class="entity-field-label">Name</label>
          <input
            ref="nameInputRef"
            v-model="entityName"
            class="entity-field-input"
            type="text"
            placeholder="Untitled"
            @keydown.enter="save"
          />
        </div>

        <!-- Dynamic fields from entity type schema -->
        <template v-for="field in schema.fields" :key="field.name">
          <div class="entity-field-row">
            <label class="entity-field-label">{{ fieldLabel(field.name) }}</label>

            <!-- Select -->
            <select
              v-if="field.type === 'select'"
              v-model="fieldValues[field.name]"
              class="entity-field-input entity-field-select"
            >
              <option value="">— none —</option>
              <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
            </select>

            <!-- entity_ref: single entity reference -->
            <div v-else-if="field.type === 'entity_ref'" class="ref-field">
              <div v-if="refEntityMap[field.name]" class="ref-chip entity-chip">
                <button
                  class="ref-chip-open"
                  :title="`Open ${refEntityMap[field.name]!.name} (Shift=new pane, Cmd=new tab)`"
                  @click="openEntityRef($event, field.name)"
                >
                  <ExternalLink :size="11" />
                  {{ refEntityMap[field.name]!.name }}
                </button>
                <button class="ref-chip-remove" title="Remove" @click="clearEntityRef(field.name)">
                  <X :size="11" />
                </button>
              </div>
              <div v-else class="ref-search-wrap">
                <input
                  v-model="refSearch[field.name]"
                  class="entity-field-input ref-search-input"
                  :placeholder="refEntityMap[field.name] ? 'Change…' : 'Search entity…'"
                  @input="searchEntityRef(field.name, field.entity_type)"
                  @focus="searchEntityRef(field.name, field.entity_type)"
                  @blur="closeSearch(field.name)"
                />
                <div
                  v-if="refSearchOpen[field.name] && refResults[field.name]?.length"
                  class="ref-dropdown"
                >
                  <button
                    v-for="item in (refResults[field.name] as RefEntityData[])"
                    :key="item.id"
                    class="ref-dropdown-item"
                    @mousedown.prevent="selectEntityRef(field.name, item)"
                  >
                    {{ item.name }}
                  </button>
                </div>
                <div
                  v-else-if="refSearchOpen[field.name] && refSearch[field.name] && !refResults[field.name]?.length"
                  class="ref-dropdown ref-dropdown-empty"
                >
                  No results
                </div>
              </div>
            </div>

            <!-- entity_ref_list: multiple entity references -->
            <div v-else-if="field.type === 'entity_ref_list'" class="ref-field">
              <div v-if="refEntityListMap[field.name]?.length" class="ref-chips-list">
                <div
                  v-for="entity in refEntityListMap[field.name]"
                  :key="entity.id"
                  class="ref-chip entity-chip"
                >
                  <button
                    class="ref-chip-open"
                    :title="`Open ${entity.name} (Shift=new pane, Cmd=new tab)`"
                    @click="openEntityFromList($event, entity)"
                  >
                    <ExternalLink :size="11" />
                    {{ entity.name }}
                  </button>
                  <button
                    class="ref-chip-remove"
                    title="Remove"
                    @click="removeEntityFromList(field.name, entity.id)"
                  >
                    <X :size="11" />
                  </button>
                </div>
              </div>
              <div class="ref-search-wrap">
                <input
                  v-model="refSearch[field.name]"
                  class="entity-field-input ref-search-input"
                  placeholder="Add entity…"
                  @input="searchEntityRef(field.name, field.entity_type)"
                  @focus="searchEntityRef(field.name, field.entity_type)"
                  @blur="closeSearch(field.name)"
                />
                <div
                  v-if="refSearchOpen[field.name] && refResults[field.name]?.length"
                  class="ref-dropdown"
                >
                  <button
                    v-for="item in (refResults[field.name] as RefEntityData[])"
                    :key="item.id"
                    class="ref-dropdown-item"
                    @mousedown.prevent="addEntityToList(field.name, item)"
                  >
                    {{ item.name }}
                  </button>
                </div>
                <div
                  v-else-if="refSearchOpen[field.name] && refSearch[field.name] && !refResults[field.name]?.length"
                  class="ref-dropdown ref-dropdown-empty"
                >
                  No results
                </div>
              </div>
            </div>

            <!-- note_ref: single note reference -->
            <div v-else-if="field.type === 'note_ref'" class="ref-field">
              <div v-if="refNoteMap[field.name]" class="ref-chip note-chip">
                <button
                  class="ref-chip-open"
                  :title="`Open ${refNoteMap[field.name]!.title} (Shift=new pane, Cmd=new tab)`"
                  @click="openNoteRef($event, field.name)"
                >
                  <ExternalLink :size="11" />
                  {{ refNoteMap[field.name]!.title }}
                </button>
                <button class="ref-chip-remove" title="Remove" @click="clearNoteRef(field.name)">
                  <X :size="11" />
                </button>
              </div>
              <div v-else class="ref-search-wrap">
                <input
                  v-model="refSearch[field.name]"
                  class="entity-field-input ref-search-input"
                  :placeholder="refNoteMap[field.name] ? 'Change…' : 'Search note…'"
                  @input="searchNoteRef(field.name)"
                  @focus="searchNoteRef(field.name)"
                  @blur="closeSearch(field.name)"
                />
                <div
                  v-if="refSearchOpen[field.name] && refResults[field.name]?.length"
                  class="ref-dropdown"
                >
                  <button
                    v-for="item in (refResults[field.name] as RefNoteData[])"
                    :key="item.id"
                    class="ref-dropdown-item"
                    @mousedown.prevent="selectNoteRef(field.name, item)"
                  >
                    {{ item.title }}
                  </button>
                </div>
                <div
                  v-else-if="refSearchOpen[field.name] && refSearch[field.name] && !refResults[field.name]?.length"
                  class="ref-dropdown ref-dropdown-empty"
                >
                  No results
                </div>
              </div>
            </div>

            <!-- text_list: comma-separated -->
            <input
              v-else-if="field.type === 'text_list'"
              v-model="fieldValues[field.name]"
              class="entity-field-input"
              type="text"
              placeholder="Comma-separated values"
            />

            <!-- text / email / date -->
            <input
              v-else
              v-model="fieldValues[field.name]"
              class="entity-field-input"
              :type="field.type"
            />
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style scoped>
.entity-detail {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.entity-detail-loading {
  padding: 24px;
  color: var(--color-text-muted);
}

.entity-detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.entity-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  user-select: none;
}

.entity-detail-save-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.entity-save-status {
  font-size: 12px;
  color: var(--color-text-muted);
}

.entity-detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.entity-field-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.entity-field-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: capitalize;
  color: var(--color-text-muted);
  letter-spacing: 0.03em;
}

.entity-field-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text);
  font-size: 14px;
  padding: 7px 10px;
  outline: none;
  transition: border-color 0.15s;
  font-family: inherit;
  width: 100%;
}

.entity-field-input:focus {
  border-color: var(--color-accent);
}

.entity-field-select {
  cursor: pointer;
}

/* ── Ref fields ──────────────────────────────────────────────────────────── */

.ref-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.ref-chips-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.ref-chip {
  display: inline-flex;
  align-items: center;
  gap: 0;
  border-radius: 4px;
  font-size: 12px;
  border: 1px solid var(--color-border);
  overflow: hidden;
  max-width: 100%;
}

.entity-chip {
  background: rgba(91, 141, 239, 0.1);
  border-color: rgba(91, 141, 239, 0.35);
}

.note-chip {
  background: rgba(80, 192, 160, 0.1);
  border-color: rgba(80, 192, 160, 0.35);
}

.ref-chip-open {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 7px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: opacity 0.1s;
}

.entity-chip .ref-chip-open {
  color: #5b8def;
}

.note-chip .ref-chip-open {
  color: #50c0a0;
}

.ref-chip-open:hover {
  opacity: 0.75;
}

.ref-chip-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 5px;
  background: transparent;
  border: none;
  border-left: 1px solid var(--color-border);
  cursor: pointer;
  color: var(--color-text-muted);
  transition: color 0.1s, background 0.1s;
  flex-shrink: 0;
}

.ref-chip-remove:hover {
  color: #f06070;
  background: rgba(240, 96, 112, 0.08);
}

.ref-search-wrap {
  position: relative;
}

.ref-search-input {
  box-sizing: border-box;
}

.ref-dropdown {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  right: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  z-index: 100;
  max-height: 200px;
  overflow-y: auto;
}

.ref-dropdown-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  background: transparent;
  border: none;
  text-align: left;
  font-size: 13px;
  font-family: inherit;
  color: var(--color-text);
  cursor: pointer;
  transition: background 0.1s;
}

.ref-dropdown-item:hover {
  background: var(--color-hover);
}

.ref-dropdown-empty {
  padding: 7px 10px;
  font-size: 12px;
  color: var(--color-text-muted);
}

/* ── Trash ───────────────────────────────────────────────────────────────── */

.btn-trash {
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 6px 8px;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
}

.btn-trash:hover:not(:disabled) {
  background: rgba(240, 96, 112, 0.1);
  color: #f06070;
  border-color: rgba(240, 96, 112, 0.4);
}

.btn-trash:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.entity-trash-confirm-msg {
  font-size: 12px;
  color: #f06070;
}

.btn-trash-confirm {
  padding: 6px 12px;
  background: rgba(240, 96, 112, 0.15);
  border: 1px solid rgba(240, 96, 112, 0.5);
  border-radius: 5px;
  color: #f06070;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.1s;
}

.btn-trash-confirm:hover {
  background: rgba(240, 96, 112, 0.25);
}
</style>
