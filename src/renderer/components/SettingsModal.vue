<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { X, Eye, EyeOff } from 'lucide-vue-next'

const emit = defineEmits<{ close: [] }>()

const apiKey = ref('')
const showKey = ref(false)
const anthropicKey = ref('')
const showAnthropicKey = ref(false)
const calendarSlotDuration = ref('30')
const saving = ref(false)
const savedFeedback = ref(false)

// ── Attendee entity config ────────────────────────────────────────────────────

interface EntityTypeRow {
  id: string
  name: string
  icon: string
  schema: string
}

interface FieldDef {
  name: string
  type: string
}

const entityTypes = ref<EntityTypeRow[]>([])
const attendeeEntityTypeId = ref('')
const attendeeNameField = ref('')
const attendeeEmailField = ref('')

const selectedEntityFields = computed<FieldDef[]>(() => {
  if (!attendeeEntityTypeId.value) return []
  const et = entityTypes.value.find(t => t.id === attendeeEntityTypeId.value)
  if (!et) return []
  try { return (JSON.parse(et.schema) as { fields: FieldDef[] }).fields ?? [] } catch { return [] }
})

const nameFieldOptions = computed(() => [
  { value: '__name__', label: 'Entity Name (primary)' },
  ...selectedEntityFields.value
    .filter(f => f.type === 'text' || f.type === 'email')
    .map(f => ({ value: f.name, label: f.name })),
])

const emailFieldOptions = computed(() =>
  selectedEntityFields.value
    .filter(f => f.type === 'text' || f.type === 'email')
    .map(f => ({ value: f.name, label: f.name }))
)

watch(attendeeEntityTypeId, () => {
  attendeeNameField.value = ''
  attendeeEmailField.value = ''
})

onMounted(async () => {
  const [openai, anthropic, slotDuration, attTypeId, attNameField, attEmailField, etList] = await Promise.all([
    window.api.invoke('settings:get', { key: 'openai_api_key' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'anthropic_api_key' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'calendar_slot_duration' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_name_field' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_email_field' }) as Promise<string | null>,
    window.api.invoke('entity-types:list') as Promise<EntityTypeRow[]>,
  ])
  apiKey.value = openai ?? ''
  anthropicKey.value = anthropic ?? ''
  calendarSlotDuration.value = slotDuration ?? '30'
  entityTypes.value = etList ?? []
  attendeeEntityTypeId.value = attTypeId ?? ''
  attendeeNameField.value = attNameField ?? ''
  attendeeEmailField.value = attEmailField ?? ''
})

async function save(): Promise<void> {
  saving.value = true
  await Promise.all([
    window.api.invoke('settings:set', { key: 'openai_api_key', value: apiKey.value.trim() }),
    window.api.invoke('settings:set', { key: 'anthropic_api_key', value: anthropicKey.value.trim() }),
    window.api.invoke('settings:set', { key: 'calendar_slot_duration', value: calendarSlotDuration.value }),
    window.api.invoke('settings:set', { key: 'attendee_entity_type_id', value: attendeeEntityTypeId.value }),
    window.api.invoke('settings:set', { key: 'attendee_name_field', value: attendeeNameField.value }),
    window.api.invoke('settings:set', { key: 'attendee_email_field', value: attendeeEmailField.value }),
  ])
  saving.value = false
  savedFeedback.value = true
  setTimeout(() => { savedFeedback.value = false }, 2000)
}

function onBackdropKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown="onBackdropKeydown">
    <div class="modal-panel" role="dialog" aria-labelledby="settings-title">
      <div class="modal-header">
        <h2 id="settings-title" class="modal-title">Settings</h2>
        <button class="modal-close" @click="emit('close')"><X :size="16" /></button>
      </div>

      <div class="modal-body">
        <section class="settings-section">
          <h3 class="section-title">AI / Embeddings</h3>

          <div class="field-group">
            <label class="modal-label" for="openai-key">OpenAI API Key</label>
            <p class="field-hint">
              Used for generating semantic search embeddings (text-embedding-3-small).
              Stored locally on your device only.
            </p>
            <div class="key-row">
              <input
                id="openai-key"
                v-model="apiKey"
                :type="showKey ? 'text' : 'password'"
                class="modal-input key-input"
                placeholder="sk-..."
                autocomplete="off"
                spellcheck="false"
              />
              <button class="toggle-btn" :title="showKey ? 'Hide' : 'Show'" @click="showKey = !showKey">
                <EyeOff v-if="showKey" :size="14" />
                <Eye v-else :size="14" />
              </button>
            </div>
          </div>

          <div class="field-group">
            <label class="modal-label" for="anthropic-key">Anthropic API Key</label>
            <p class="field-hint">
              Used for generating note summaries (L2 embeddings) via Claude Haiku.
              Stored locally on your device only.
            </p>
            <div class="key-row">
              <input
                id="anthropic-key"
                v-model="anthropicKey"
                :type="showAnthropicKey ? 'text' : 'password'"
                class="modal-input key-input"
                placeholder="sk-ant-..."
                autocomplete="off"
                spellcheck="false"
              />
              <button class="toggle-btn" :title="showAnthropicKey ? 'Hide' : 'Show'" @click="showAnthropicKey = !showAnthropicKey">
                <EyeOff v-if="showAnthropicKey" :size="14" />
                <Eye v-else :size="14" />
              </button>
            </div>
          </div>
        </section>

        <section class="settings-section">
          <h3 class="section-title">Calendar</h3>
          <div class="field-group">
            <label class="modal-label">Default Slot Duration</label>
            <p class="field-hint">Duration of a new meeting when clicking or dragging a time slot.</p>
            <div class="slot-picker">
              <button
                v-for="opt in [{ label: '15 min', value: '15' }, { label: '30 min', value: '30' }, { label: '1 hour', value: '60' }]"
                :key="opt.value"
                class="slot-btn"
                :class="{ active: calendarSlotDuration === opt.value }"
                @click="calendarSlotDuration = opt.value"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>

          <div class="field-group">
            <label class="modal-label">Attendee Entity</label>
            <p class="field-hint">
              Link meeting attendees to entities. When configured, the meeting modal lets you search and pick existing entities instead of typing name and email manually.
            </p>
            <select v-model="attendeeEntityTypeId" class="modal-input modal-select">
              <option value="">None (free-form name + email)</option>
              <option v-for="et in entityTypes" :key="et.id" :value="et.id">{{ et.name }}</option>
            </select>
            <template v-if="attendeeEntityTypeId">
              <div class="attendee-field-row">
                <div class="attendee-field-col">
                  <label class="modal-label">Name Field</label>
                  <select v-model="attendeeNameField" class="modal-input modal-select">
                    <option value="">— select field —</option>
                    <option v-for="f in nameFieldOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
                  </select>
                </div>
                <div class="attendee-field-col">
                  <label class="modal-label">Email Field</label>
                  <select v-model="attendeeEmailField" class="modal-input modal-select">
                    <option value="">— select field —</option>
                    <option v-for="f in emailFieldOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
                  </select>
                </div>
              </div>
            </template>
          </div>
        </section>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="saving" @click="save">
          {{ savedFeedback ? 'Saved!' : saving ? 'Saving…' : 'Save' }}
        </button>
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
  width: 480px;
  max-width: 95vw;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
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
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-muted);
  margin: 0 0 12px;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.field-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0;
  line-height: 1.5;
}

.key-row {
  display: flex;
  gap: 6px;
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

.key-input {
  flex: 1;
  font-family: monospace;
}

.toggle-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 10px;
  display: flex;
  align-items: center;
  transition: color 0.15s;
}

.toggle-btn:hover {
  color: var(--color-text);
}

.settings-section + .settings-section {
  border-top: 1px solid var(--color-border);
  padding-top: 16px;
}

.modal-select {
  width: 100%;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

.attendee-field-row {
  display: flex;
  gap: 8px;
}

.attendee-field-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.slot-picker {
  display: flex;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  overflow: hidden;
  width: fit-content;
}

.slot-btn {
  padding: 6px 16px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
}

.slot-btn:last-child {
  border-right: none;
}

.slot-btn:hover {
  background: var(--color-hover);
  color: var(--color-text);
}

.slot-btn.active {
  background: var(--color-accent);
  color: #fff;
  font-weight: 500;
}

.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.modal-footer :global(.btn-primary) {
  margin-top: 0;
  font-family: inherit;
}
</style>
