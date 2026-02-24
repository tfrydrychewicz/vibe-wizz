<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { Plus, Trash2, X } from 'lucide-vue-next'
import IconPicker from './IconPicker.vue'

type FieldType =
  | 'text'
  | 'email'
  | 'date'
  | 'select'
  | 'entity_ref'
  | 'entity_ref_list'
  | 'text_list'
  | 'note_ref'

type FieldDef = {
  name: string
  type: FieldType
  options: string   // comma-separated, only for 'select'
  entity_type: string // only for entity_ref / entity_ref_list
}

type StoredFieldDef = {
  name: string
  type: FieldType
  options?: string[]
  entity_type?: string
}

type ExistingType = {
  id: string
  name: string
  icon: string
}

type EntityTypeRow = {
  id: string
  name: string
  icon: string
  color: string | null
  schema: string
}

const props = defineProps<{
  editingType?: EntityTypeRow  // undefined = create mode
}>()

const emit = defineEmits<{
  created: [entityType: EntityTypeRow]
  updated: [entityType: EntityTypeRow]
  deleted: [id: string]
  cancel: []
}>()

const isEditMode = computed(() => props.editingType !== undefined)

const COLORS = ['#5b8def', '#f0a050', '#50c0a0', '#c070f0', '#f06070', '#60c0f0', '#a0d060', '#f0d050']

const typeName = ref('')
const typeIcon = ref('tag')
const typeColor = ref(COLORS[0])
const fields = ref<FieldDef[]>([])
const existingTypes = ref<ExistingType[]>([])
const error = ref('')
const isSaving = ref(false)
const confirmingDelete = ref(false)
const isDeleting = ref(false)
const deleteError = ref('')

async function deleteType(): Promise<void> {
  if (!props.editingType) return
  isDeleting.value = true
  deleteError.value = ''
  const result = (await window.api.invoke('entity-types:delete', { id: props.editingType.id })) as { ok: boolean; error?: string }
  isDeleting.value = false
  if (result?.error) {
    deleteError.value = result.error
    confirmingDelete.value = false
  } else {
    emit('deleted', props.editingType.id)
  }
}

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'email', label: 'Email' },
  { value: 'date', label: 'Date' },
  { value: 'select', label: 'Select (options)' },
  { value: 'text_list', label: 'Text list (comma-separated)' },
  { value: 'entity_ref', label: 'Entity reference' },
  { value: 'entity_ref_list', label: 'Entity reference list' },
  { value: 'note_ref', label: 'Note reference' },
]

function addField(): void {
  fields.value.push({ name: '', type: 'text', options: '', entity_type: '' })
}

function removeField(index: number): void {
  fields.value.splice(index, 1)
}

function buildSchema(): string {
  const schemaFields = fields.value
    .filter((f) => f.name.trim() !== '')
    .map((f) => {
      const def: Record<string, unknown> = {
        name: f.name.trim().toLowerCase().replace(/\s+/g, '_'),
        type: f.type,
      }
      if (f.type === 'select') {
        def.options = f.options
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      }
      if ((f.type === 'entity_ref' || f.type === 'entity_ref_list') && f.entity_type) {
        def.entity_type = f.entity_type
      }
      return def
    })
  return JSON.stringify({ fields: schemaFields })
}

async function save(): Promise<void> {
  error.value = ''
  const name = typeName.value.trim()
  if (!name) {
    error.value = 'Name is required.'
    return
  }

  isSaving.value = true
  const schema = buildSchema()

  if (isEditMode.value && props.editingType) {
    const result = (await window.api.invoke('entity-types:update', {
      id: props.editingType.id,
      name,
      icon: typeIcon.value || 'tag',
      color: typeColor.value,
      schema,
    })) as EntityTypeRow
    isSaving.value = false
    emit('updated', result)
  } else {
    const result = (await window.api.invoke('entity-types:create', {
      name,
      icon: typeIcon.value || 'tag',
      color: typeColor.value,
      schema,
    })) as EntityTypeRow
    isSaving.value = false
    emit('created', result)
  }
}

onMounted(async () => {
  existingTypes.value = (await window.api.invoke('entity-types:list')) as ExistingType[]

  if (props.editingType) {
    typeName.value = props.editingType.name
    typeIcon.value = props.editingType.icon
    typeColor.value = props.editingType.color ?? COLORS[0]

    // Pre-populate fields from stored schema
    try {
      const parsed = JSON.parse(props.editingType.schema) as { fields?: StoredFieldDef[] }
      fields.value = (parsed.fields ?? []).map((f) => ({
        name: f.name,
        type: f.type,
        options: Array.isArray(f.options) ? f.options.join(', ') : '',
        entity_type: f.entity_type ?? '',
      }))
    } catch {
      fields.value = []
    }
  }
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('cancel')">
    <div class="modal-panel">
      <div class="modal-header">
        <h2 class="modal-title">{{ isEditMode ? `Edit "${typeName || editingType?.name}"` : 'New Entity Type' }}</h2>
        <button class="modal-close" @click="emit('cancel')"><X :size="16" /></button>
      </div>

      <div class="modal-body">
        <!-- Name -->
        <div class="modal-field">
          <label class="modal-label">Name</label>
          <input v-model="typeName" class="modal-input" type="text" placeholder="e.g. Vendor" autofocus />
        </div>

        <!-- Icon picker -->
        <div class="modal-field">
          <label class="modal-label">Icon</label>
          <IconPicker v-model="typeIcon" :color="typeColor" />
        </div>

        <!-- Color -->
        <div class="modal-field">
          <label class="modal-label">Color</label>
          <div class="color-swatches">
            <button
              v-for="c in COLORS"
              :key="c"
              class="color-swatch"
              :style="{ background: c, outline: typeColor === c ? `2px solid ${c}` : 'none' }"
              @click="typeColor = c"
            />
          </div>
        </div>

        <!-- Fields -->
        <div class="modal-field">
          <div class="modal-label-row">
            <label class="modal-label">Fields</label>
            <button class="btn-add-field" @click="addField">
              <Plus :size="12" /> Add field
            </button>
          </div>

          <div v-if="fields.length === 0" class="fields-empty">
            No fields yet. Click "Add field" to define custom properties.
          </div>

          <div class="fields-list">
            <div v-for="(field, i) in fields" :key="i" class="field-row">
              <input
                v-model="field.name"
                class="modal-input field-name-input"
                type="text"
                placeholder="field name"
              />
              <select v-model="field.type" class="modal-input field-type-select">
                <option v-for="ft in FIELD_TYPES" :key="ft.value" :value="ft.value">
                  {{ ft.label }}
                </option>
              </select>

              <!-- Options input for 'select' type -->
              <input
                v-if="field.type === 'select'"
                v-model="field.options"
                class="modal-input field-extra-input"
                type="text"
                placeholder="opt1, opt2, opt3"
              />

              <!-- Entity type picker for entity_ref / entity_ref_list -->
              <select
                v-else-if="field.type === 'entity_ref' || field.type === 'entity_ref_list'"
                v-model="field.entity_type"
                class="modal-input field-extra-input"
              >
                <option value="">— any type —</option>
                <option v-for="et in existingTypes" :key="et.id" :value="et.id">
                  {{ et.name }}
                </option>
              </select>

              <button class="field-remove-btn" title="Remove field" @click="removeField(i)">
                <Trash2 :size="13" />
              </button>
            </div>
          </div>
        </div>

        <p v-if="error" class="modal-error">{{ error }}</p>
      </div>

      <div class="modal-footer">
        <!-- Delete (edit mode only) -->
        <template v-if="isEditMode">
          <template v-if="confirmingDelete">
            <span class="delete-confirm-msg">Delete this entity type?</span>
            <button class="btn-delete-confirm" :disabled="isDeleting" @click="deleteType">
              {{ isDeleting ? 'Deleting…' : 'Delete' }}
            </button>
            <button class="btn-secondary" @click="confirmingDelete = false">Cancel</button>
          </template>
          <template v-else>
            <button class="btn-delete" @click="confirmingDelete = true">
              <Trash2 :size="13" /> Delete type
            </button>
          </template>
          <p v-if="deleteError" class="modal-error delete-error">{{ deleteError }}</p>
        </template>

        <div class="modal-footer-right">
          <button class="btn-secondary" @click="emit('cancel')">Cancel</button>
          <button class="btn-primary" :disabled="isSaving" @click="save">
            {{ isSaving ? (isEditMode ? 'Saving…' : 'Creating…') : (isEditMode ? 'Save' : 'Create') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  width: 700px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
}

.modal-close:hover {
  color: var(--color-text);
}

.modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-row {
  display: flex;
  gap: 10px;
}

.modal-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.modal-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.modal-input {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text);
  font-size: 13px;
  padding: 7px 10px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.modal-input:focus {
  border-color: var(--color-accent);
}

.color-swatches {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.color-swatch {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  outline-offset: 2px;
  transition: transform 0.1s;
}

.color-swatch:hover {
  transform: scale(1.15);
}

.btn-add-field {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: 1px dashed var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 12px;
  padding: 3px 8px;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
  font-family: inherit;
}

.btn-add-field:hover {
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.fields-empty {
  font-size: 12px;
  color: var(--color-text-muted);
  padding: 10px 0;
}

.fields-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-row {
  display: flex;
  gap: 6px;
  align-items: center;
}

.field-name-input {
  flex: 0 0 160px;
}

.field-type-select {
  flex: 1;
  cursor: pointer;
}

.field-extra-input {
  flex: 0 0 180px;
}

.field-remove-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.field-remove-btn:hover {
  color: #f06070;
}

.modal-error {
  font-size: 12px;
  color: #f06070;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.modal-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.btn-delete {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  padding: 6px 10px;
  cursor: pointer;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
}

.btn-delete:hover {
  background: rgba(240, 96, 112, 0.1);
  color: #f06070;
  border-color: rgba(240, 96, 112, 0.4);
}

.delete-confirm-msg {
  font-size: 12px;
  color: #f06070;
}

.btn-delete-confirm {
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

.btn-delete-confirm:hover:not(:disabled) {
  background: rgba(240, 96, 112, 0.25);
}

.btn-delete-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.delete-error {
  margin: 0;
}

/* btn-primary has global margin-top: 16px — reset it in modal footer */
.modal-footer :global(.btn-primary) {
  margin-top: 0;
  font-family: inherit;
}
</style>
