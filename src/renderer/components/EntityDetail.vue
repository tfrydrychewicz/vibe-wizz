<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import LucideIcon from './LucideIcon.vue'

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
const emit = defineEmits<{ saved: [] }>()

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
  emit('saved')
  setTimeout(() => {
    saveStatus.value = ''
  }, 1500)
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
          <button class="btn-primary" @click="save">Save</button>
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
</style>
