<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Eye, EyeOff, Loader2, X } from 'lucide-vue-next'

interface ProviderModel {
  id: string
  label: string
  capabilities: string[]
  enabled: boolean
}

const props = defineProps<{
  providerId: string
  providerLabel: string
  apiKey: string
  models: ProviderModel[]
  /** 'api_key' (default): masked secret input. 'base_url': plain URL input, no masking. */
  credentialType?: 'api_key' | 'base_url'
  /** Pre-filled value for new providers (e.g. 'http://localhost:11434' for Ollama). */
  credentialDefault?: string
  /** Placeholder text for the credential input. */
  credentialPlaceholder?: string
}>()

const emit = defineEmits<{
  deleted: []
}>()

const isBaseUrl = computed(() => props.credentialType === 'base_url')

const localKey = ref(props.apiKey)
const showKey = ref(false)
const fetchedModels = ref<ProviderModel[]>(props.models)
const enabledIds = ref(new Set(props.models.filter((m) => m.enabled).map((m) => m.id)))

const isFetching = ref(false)
const fetchError = ref('')
const showDeleteConfirm = ref(false)

// For base_url providers, pre-fill the default when the card is freshly added (apiKey is empty).
onMounted(() => {
  if (isBaseUrl.value && !localKey.value && props.credentialDefault) {
    localKey.value = props.credentialDefault
  }
})

const hasFetchedModels = computed(() => fetchedModels.value.length > 0)

// For base_url providers the button is always enabled (URL has a non-empty default).
const fetchDisabled = computed(() =>
  isFetching.value || (!isBaseUrl.value && !localKey.value.trim()),
)

const inputPlaceholder = computed(() =>
  props.credentialPlaceholder ?? (isBaseUrl.value ? 'http://localhost:11434' : 'API key'),
)

const hintText = computed(() =>
  isBaseUrl.value
    ? 'Click Refresh to discover models installed in your local Ollama instance.'
    : 'Enter your API key and click Test to fetch available models.',
)

type Capability = 'chat' | 'image' | 'embedding'
const CAP_LABELS: Record<Capability, string> = { chat: 'Chat', image: 'Image generation', embedding: 'Embeddings' }
const CAP_ORDER: Capability[] = ['chat', 'image', 'embedding']

const modelGroups = computed(() => {
  const groups: { cap: Capability; models: ProviderModel[] }[] = []
  for (const cap of CAP_ORDER) {
    const models = fetchedModels.value.filter((m) => m.capabilities.includes(cap))
    if (models.length > 0) groups.push({ cap, models })
  }
  return groups
})

async function fetchModels(): Promise<void> {
  // For api_key providers, require a non-empty key. For base_url providers, always allow.
  if (!isBaseUrl.value && !localKey.value.trim()) return
  isFetching.value = true
  fetchError.value = ''
  try {
    const result = await window.api.invoke('ai-providers:fetch-models', {
      id: props.providerId,
      apiKey: localKey.value.trim(),
    }) as ProviderModel[]
    fetchedModels.value = result
    // Enable all fetched models by default when none are enabled yet
    if (enabledIds.value.size === 0) {
      enabledIds.value = new Set(result.map((m) => m.id))
    }
  } catch (err) {
    fetchError.value = err instanceof Error ? err.message : 'Connection failed'
  } finally {
    isFetching.value = false
  }
}

function getData() {
  return {
    apiKey: localKey.value.trim(),
    enabledModelIds: [...enabledIds.value],
    models: fetchedModels.value.map((m) => ({
      id: m.id,
      label: m.label,
      capabilities: [...m.capabilities],
    })),
  }
}

defineExpose({ getData })

async function deleteProvider(): Promise<void> {
  await window.api.invoke('ai-providers:delete', { id: props.providerId })
  emit('deleted')
}

function toggleModel(id: string): void {
  if (enabledIds.value.has(id)) {
    enabledIds.value.delete(id)
  } else {
    enabledIds.value.add(id)
  }
}
</script>

<template>
  <div class="provider-card">
    <div class="provider-card-header">
      <span class="provider-name">{{ providerLabel }}</span>
      <div class="provider-header-actions">
        <template v-if="showDeleteConfirm">
          <span class="delete-confirm-text">Remove provider?</span>
          <button class="dc-cancel-btn" @click="showDeleteConfirm = false">Cancel</button>
          <button class="dc-delete-btn" @click="deleteProvider">Remove</button>
        </template>
        <button
          v-else
          class="provider-delete-btn"
          title="Remove provider"
          @click="showDeleteConfirm = true"
        >
          <X :size="13" />
        </button>
      </div>
    </div>

    <div class="provider-key-row">
      <input
        v-model="localKey"
        :type="isBaseUrl || showKey ? 'text' : 'password'"
        class="modal-input key-input"
        :class="{ 'key-input--url': isBaseUrl }"
        :placeholder="inputPlaceholder"
        autocomplete="off"
        spellcheck="false"
      />
      <!-- Show/hide toggle: only for API key providers (URLs are not secrets) -->
      <button
        v-if="!isBaseUrl"
        class="toggle-btn"
        :title="showKey ? 'Hide' : 'Show'"
        @click="showKey = !showKey"
      >
        <EyeOff v-if="showKey" :size="14" />
        <Eye v-else :size="14" />
      </button>
      <button
        class="fetch-btn"
        :disabled="fetchDisabled"
        @click="fetchModels"
      >
        <Loader2 v-if="isFetching" :size="12" class="spin" />
        <span>{{ hasFetchedModels ? 'Refresh' : (isBaseUrl ? 'Refresh' : 'Test') }}</span>
      </button>
    </div>

    <p v-if="fetchError" class="provider-error">{{ fetchError }}</p>

    <div v-if="hasFetchedModels" class="provider-models">
      <template v-for="group in modelGroups" :key="group.cap">
        <div v-if="modelGroups.length > 1" class="model-group-header">{{ CAP_LABELS[group.cap] }}</div>
        <label
          v-for="model in group.models"
          :key="model.id"
          class="model-checkbox-row"
        >
          <input
            type="checkbox"
            :checked="enabledIds.has(model.id)"
            class="toggle-checkbox"
            @change="toggleModel(model.id)"
          />
          <span class="model-label-text">{{ model.label }}</span>
        </label>
      </template>
    </div>
    <p v-else class="provider-hint">{{ hintText }}</p>

  </div>
</template>

<style scoped>
.provider-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px 14px;
  background: var(--color-bg);
}

.provider-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.provider-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text);
}

.provider-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.delete-confirm-text {
  font-size: 11px;
  color: var(--color-text-muted);
}

.dc-cancel-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-family: inherit;
}

.dc-delete-btn {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid transparent;
  background: var(--color-danger-subtle);
  color: var(--color-danger);
  cursor: pointer;
  font-family: inherit;
}

.provider-delete-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  opacity: 0.5;
  transition: opacity 0.15s, background 0.12s;
}

.provider-delete-btn:hover {
  opacity: 1;
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.provider-key-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}

/* Match SettingsModal's .modal-input + .key-input */
.key-input {
  flex: 1;
  background: color-mix(in srgb, var(--color-bg) 80%, var(--color-surface));
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 13px;
  padding: 6px 10px;
  outline: none;
  font-family: monospace;
  transition: border-color 0.15s;
}

/* URL inputs use the regular font — they're not secrets and don't need monospace. */
.key-input--url {
  font-family: inherit;
}

.key-input:focus {
  border-color: var(--color-accent);
}

.key-input::placeholder {
  color: var(--color-text-muted);
  opacity: 0.7;
  font-family: inherit;
}

/* Match SettingsModal's .toggle-btn */
.toggle-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 9px;
  height: 32px;
  display: flex;
  align-items: center;
  flex-shrink: 0;
  transition: color 0.15s;
}

.toggle-btn:hover {
  color: var(--color-text);
}

.fetch-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 12px;
  height: 32px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}

.fetch-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}

.fetch-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.provider-error {
  font-size: 11px;
  color: var(--color-danger);
  margin: 0 0 6px;
}

.provider-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0 0 8px;
  line-height: 1.5;
}

.provider-models {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 6px 8px;
}

.model-group-header {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
  padding: 6px 0 3px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 2px;
}

.model-group-header:first-child {
  padding-top: 2px;
}

/* Match SettingsModal's .toggle-row */
.model-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--color-text);
  padding: 2px 0;
}

.toggle-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 14px;
  height: 14px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-surface);
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: background 0.12s, border-color 0.12s;
}

.toggle-checkbox:checked {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.toggle-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 3px;
  top: 0px;
  width: 5px;
  height: 8px;
  border: 1.5px solid #fff;
  border-top: none;
  border-left: none;
  transform: rotate(45deg);
}

.model-label-text {
  flex: 1;
}


.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
