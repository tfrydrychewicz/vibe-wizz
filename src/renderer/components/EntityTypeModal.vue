<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { Plus, Trash2, X, Wand2 } from 'lucide-vue-next'
import IconPicker from './IconPicker.vue'
import QueryFieldEditor from './QueryFieldEditor.vue'

type FieldType =
  | 'text'
  | 'email'
  | 'date'
  | 'select'
  | 'entity_ref'
  | 'entity_ref_list'
  | 'text_list'
  | 'note_ref'
  | 'computed'

type FieldDef = {
  name: string
  type: FieldType
  options: string     // comma-separated, only for 'select'
  entity_type: string // only for entity_ref / entity_ref_list
  query: string       // WQL source, only for 'computed'
}

type StoredFieldDef = {
  name: string
  type: FieldType
  options?: string[]
  entity_type?: string
  query?: string
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
  review_enabled: number
  review_frequency: string | null
  review_day: string | null
  review_time: string
  review_guidance: string | null
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

// ── Review schedule state ─────────────────────────────────────────────────────
const reviewEnabled = ref(false)
const reviewFrequency = ref<'daily' | 'weekly' | 'biweekly' | 'monthly'>('weekly')
const reviewDay = ref<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'>('mon')
const reviewTime = ref('07:00')
const reviewGuidance = ref('')
const generatingGuidance = ref(false)
const guidanceError = ref('')

const DAY_LABELS: Record<string, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
}

const reviewDescription = computed((): string => {
  if (!reviewEnabled.value) return ''
  const time = reviewTime.value || '07:00'
  const [h, m] = time.split(':')
  const hour = parseInt(h ?? '7', 10)
  const minute = m ?? '00'
  const ampm = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  const timeStr = `${hour12}:${minute} ${ampm}`

  if (reviewFrequency.value === 'daily') return `Reviews will be generated every day at ${timeStr}.`
  if (reviewFrequency.value === 'monthly') return `Reviews will be generated monthly at ${timeStr}.`
  const dayLabel = DAY_LABELS[reviewDay.value] ?? reviewDay.value
  const freqLabel = reviewFrequency.value === 'biweekly' ? 'every two weeks' : 'every week'
  return `Reviews will be generated ${freqLabel} on ${dayLabel} at ${timeStr}.`
})

const needsDayPicker = computed(() =>
  reviewEnabled.value && (reviewFrequency.value === 'weekly' || reviewFrequency.value === 'biweekly'),
)

async function generateGuidance(): Promise<void> {
  generatingGuidance.value = true
  guidanceError.value = ''
  try {
    const name = typeName.value.trim() || props.editingType?.name || 'this type'
    const fieldNames = fields.value
      .filter((f) => f.name.trim())
      .map((f) => f.name.trim())
    const result = await window.api.invoke(
      'entity-types:generate-review-guidance',
      { type_name: name, field_names: fieldNames },
    ) as { guidance?: string; error?: string }
    if (result.error) {
      guidanceError.value = result.error
    } else {
      reviewGuidance.value = result.guidance ?? ''
    }
  } catch {
    guidanceError.value = 'Failed to generate guidance.'
  } finally {
    generatingGuidance.value = false
  }
}

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
  { value: 'computed', label: 'Computed query' },
]

function addField(): void {
  fields.value.push({ name: '', type: 'text', options: '', entity_type: '', query: '' })
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
      if (f.type === 'computed') {
        def.query = f.query.trim()
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
  if (reviewEnabled.value && !reviewFrequency.value) {
    error.value = 'Please select a review frequency.'
    return
  }
  if (needsDayPicker.value && !reviewDay.value) {
    error.value = 'Please select a day of the week for the review.'
    return
  }

  isSaving.value = true
  const schema = buildSchema()

  const reviewPayload = {
    review_enabled: reviewEnabled.value ? 1 : 0,
    review_frequency: reviewEnabled.value ? reviewFrequency.value : null,
    review_day: needsDayPicker.value ? reviewDay.value : null,
    review_time: reviewEnabled.value ? (reviewTime.value || '07:00') : '07:00',
    review_guidance: reviewGuidance.value.trim() || null,
  }

  if (isEditMode.value && props.editingType) {
    const result = (await window.api.invoke('entity-types:update', {
      id: props.editingType.id,
      name,
      icon: typeIcon.value || 'tag',
      color: typeColor.value,
      schema,
      ...reviewPayload,
    })) as EntityTypeRow
    isSaving.value = false
    emit('updated', result)
  } else {
    const result = (await window.api.invoke('entity-types:create', {
      name,
      icon: typeIcon.value || 'tag',
      color: typeColor.value,
      schema,
      ...reviewPayload,
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
        query: f.query ?? '',
      }))
    } catch {
      fields.value = []
    }

    // Pre-populate review schedule
    reviewEnabled.value = props.editingType.review_enabled === 1
    if (props.editingType.review_frequency) {
      reviewFrequency.value = props.editingType.review_frequency as typeof reviewFrequency.value
    }
    if (props.editingType.review_day) {
      reviewDay.value = props.editingType.review_day as typeof reviewDay.value
    }
    if (props.editingType.review_time) {
      reviewTime.value = props.editingType.review_time
    }
    if (props.editingType.review_guidance) {
      reviewGuidance.value = props.editingType.review_guidance
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
            <div v-for="(field, i) in fields" :key="i" class="field-entry">
              <div class="field-row">
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

              <!-- WQL query editor for 'computed' type -->
              <QueryFieldEditor
                v-if="field.type === 'computed'"
                v-model="field.query"
              />
            </div>
          </div>
        </div>

        <!-- Automated Reviews -->
        <div class="modal-field reviews-section">
          <div class="reviews-header">
            <span class="modal-label">Automated Reviews</span>
            <label class="toggle-row">
              <input v-model="reviewEnabled" type="checkbox" class="toggle-checkbox" />
              <span class="toggle-label">{{ reviewEnabled ? 'On' : 'Off' }}</span>
            </label>
          </div>

          <template v-if="reviewEnabled">
            <div class="reviews-controls">
              <div class="reviews-control-row">
                <label class="reviews-control-label">Frequency</label>
                <select v-model="reviewFrequency" class="modal-input reviews-select">
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="biweekly">Biweekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>

              <div v-if="needsDayPicker" class="reviews-control-row">
                <label class="reviews-control-label">Day</label>
                <select v-model="reviewDay" class="modal-input reviews-select">
                  <option value="mon">Monday</option>
                  <option value="tue">Tuesday</option>
                  <option value="wed">Wednesday</option>
                  <option value="thu">Thursday</option>
                  <option value="fri">Friday</option>
                  <option value="sat">Saturday</option>
                  <option value="sun">Sunday</option>
                </select>
              </div>

              <div class="reviews-control-row">
                <label class="reviews-control-label">Time</label>
                <input v-model="reviewTime" type="time" class="modal-input reviews-time-input" />
              </div>
            </div>

            <p class="reviews-description">{{ reviewDescription }}</p>

            <!-- Review Guidance -->
            <div class="reviews-guidance-section">
              <div class="reviews-guidance-header">
                <label class="reviews-control-label">AI Focus Guidance</label>
                <button
                  class="btn-generate-guidance"
                  :disabled="generatingGuidance"
                  title="Generate guidance with AI"
                  @click="generateGuidance"
                >
                  <Wand2 :size="12" />
                  {{ generatingGuidance ? 'Generating…' : 'Generate with AI' }}
                </button>
              </div>
              <textarea
                v-model="reviewGuidance"
                class="reviews-guidance-textarea"
                placeholder="e.g. relationship health, commitments made and received, open follow-ups, and any collaboration patterns worth highlighting"
                rows="3"
              />
              <p v-if="guidanceError" class="reviews-guidance-error">{{ guidanceError }}</p>
              <p class="reviews-hint">
                Tells the AI what to focus on. Leave blank to use a generic summary. AI model used from <strong>Settings → AI Features → Entity Review Summary</strong>.
              </p>
            </div>
          </template>

          <p v-else class="reviews-hint">
            When enabled, Wizz generates a periodic AI summary for each entity of this type — covering mentions in notes, action items, and calendar events.
          </p>
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

.field-entry {
  display: flex;
  flex-direction: column;
  gap: 5px;
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

/* ── Automated Reviews section ── */

.reviews-section {
  border-top: 1px solid var(--color-border);
  padding-top: 16px;
}

.reviews-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.reviews-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}

.reviews-control-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.reviews-control-label {
  font-size: 12px;
  color: var(--color-text-muted);
  width: 70px;
  flex-shrink: 0;
}

.reviews-select {
  width: 180px;
}

.reviews-time-input {
  width: 120px;
}

.reviews-description {
  margin-top: 6px;
  font-size: 12px;
  color: var(--color-text);
  line-height: 1.5;
}

.reviews-hint {
  font-size: 11.5px;
  color: var(--color-text-muted);
  line-height: 1.5;
  margin-top: 4px;
}

.reviews-hint strong {
  color: var(--color-text);
  font-weight: 500;
}

.reviews-guidance-section {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reviews-guidance-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.reviews-guidance-textarea {
  width: 100%;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12.5px;
  font-family: inherit;
  line-height: 1.5;
  padding: 7px 10px;
  resize: vertical;
  min-height: 64px;
  transition: border-color 0.15s;
}

.reviews-guidance-textarea:focus {
  outline: none;
  border-color: var(--color-accent);
}

.reviews-guidance-textarea::placeholder {
  color: var(--color-text-muted);
  font-style: italic;
}

.reviews-guidance-error {
  font-size: 11.5px;
  color: #ef4444;
  margin: 0;
}

.btn-generate-guidance {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11.5px;
  font-weight: 500;
  font-family: inherit;
  background: rgba(91, 141, 239, 0.1);
  color: var(--color-accent);
  border: 1px solid rgba(91, 141, 239, 0.25);
  cursor: pointer;
  transition: background 0.1s, opacity 0.1s;
  white-space: nowrap;
  flex-shrink: 0;
}

.btn-generate-guidance:hover:not(:disabled) {
  background: rgba(91, 141, 239, 0.2);
}

.btn-generate-guidance:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* Toggle (reuses SettingsModal pattern) */
.toggle-row {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  user-select: none;
}

.toggle-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--color-accent);
  cursor: pointer;
}

.toggle-label {
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
