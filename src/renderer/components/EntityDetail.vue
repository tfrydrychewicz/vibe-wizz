<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'
import { entityTrashStatus } from '../stores/mentionStore'

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

const props = defineProps<{ entityId: string }>()
const emit = defineEmits<{
  saved: [name: string]
  loaded: [name: string]
  trashed: [entityId: string]
}>()

const entityName = ref('')
const fieldValues = ref<Record<string, string>>({})
const schema = ref<EntitySchema>({ fields: [] })
const entityType = ref<EntityTypeRow | null>(null)
const saveStatus = ref<'' | 'saving' | 'saved'>('')
const isLoading = ref(false)

async function loadEntity(id: string): Promise<void> {
  isLoading.value = true
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

  // Initialise fieldValues from stored fields (all as strings for form binding)
  const values: Record<string, string> = {}
  for (const field of schema.value.fields) {
    const stored = parsedFields[field.name]
    values[field.name] = stored != null ? String(stored) : ''
  }
  fieldValues.value = values
  isLoading.value = false
  emit('loaded', entityName.value || 'Untitled')
}

async function save(): Promise<void> {
  if (isLoading.value) return
  saveStatus.value = 'saving'
  const fields: Record<string, unknown> = {}
  for (const field of schema.value.fields) {
    fields[field.name] = fieldValues.value[field.name] ?? ''
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

function isRefField(type: string): boolean {
  return type === 'entity_ref' || type === 'entity_ref_list' || type === 'note_ref'
}

function fieldLabel(name: string): string {
  return name.replace(/_/g, ' ')
}

onMounted(() => loadEntity(props.entityId))
watch(() => props.entityId, loadEntity)
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

            <!-- Ref fields (placeholder for Phase 2) -->
            <input
              v-else-if="isRefField(field.type)"
              class="entity-field-input entity-field-disabled"
              type="text"
              disabled
              placeholder="Entity linking in Phase 2"
            />

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

.entity-field-disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

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
