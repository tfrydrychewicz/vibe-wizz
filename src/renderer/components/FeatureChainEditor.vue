<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { X, Plus } from 'lucide-vue-next'

interface EnabledModel {
  id: string
  label: string
  providerId: string
  providerLabel: string
  capability: string
}

const props = defineProps<{
  featureSlot: string
  label: string
  description: string
  capability: 'chat' | 'embedding' | 'image'
  modelIds: string[]
  availableModels: EnabledModel[]
}>()

const emit = defineEmits<{
  change: [{ featureSlot: string; modelIds: string[] }]
}>()

const chain = ref([...props.modelIds])

watch(
  () => props.modelIds,
  (v) => { chain.value = [...v] },
)

const filteredModels = computed(() =>
  props.availableModels.filter((m) => m.capability === props.capability),
)

function addFallback(): void {
  const next = filteredModels.value.find((m) => !chain.value.includes(m.id))
  chain.value.push(next?.id ?? filteredModels.value[0]?.id ?? '')
  emitChange()
}

function remove(idx: number): void {
  chain.value.splice(idx, 1)
  emitChange()
}

function onSelect(): void {
  emitChange()
}

function emitChange(): void {
  emit('change', { featureSlot: props.featureSlot, modelIds: chain.value.filter(Boolean) })
}
</script>

<template>
  <div class="fce-row">
    <div class="fce-label-col">
      <span class="fce-label">{{ label }}</span>
      <span class="fce-description">{{ description }}</span>
    </div>
    <div class="fce-chain-col">
      <template v-if="filteredModels.length === 0">
        <span class="fce-no-models">No models available</span>
      </template>
      <template v-else>
        <template v-for="(modelId, idx) in chain" :key="idx">
          <span v-if="idx > 0" class="fce-arrow">→</span>
          <div class="fce-model-slot">
            <select
              v-model="chain[idx]"
              class="fce-model-select"
              @change="onSelect"
            >
              <option value="">(none)</option>
              <option
                v-for="m in filteredModels"
                :key="m.id"
                :value="m.id"
              >{{ m.label }}</option>
            </select>
            <button
              v-if="chain.length > 1"
              class="fce-remove-btn"
              title="Remove"
              @click="remove(idx)"
            >
              <X :size="11" />
            </button>
          </div>
        </template>
        <span v-if="chain.length > 0 && filteredModels.length > chain.length" class="fce-arrow">→</span>
        <button
          v-if="filteredModels.length > chain.length"
          class="fce-add-btn"
          @click="addFallback"
        >
          <Plus :size="11" />
          fallback
        </button>
        <button
          v-if="chain.length === 0"
          class="fce-add-btn"
          @click="addFallback"
        >
          <Plus :size="11" />
          Add model
        </button>
        <span v-if="chain.length === 0" class="fce-default-hint">(using default)</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.fce-row {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--color-border);
}

.fce-row:last-child {
  border-bottom: none;
}

.fce-label-col {
  width: 180px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 2px;
}

.fce-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  line-height: 1.3;
}

.fce-description {
  font-size: 11px;
  color: var(--color-text-muted);
  line-height: 1.4;
}

.fce-chain-col {
  flex: 1;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 28px;
}

.fce-model-slot {
  display: flex;
  align-items: center;
  gap: 2px;
}

.fce-model-select {
  font-size: 12px;
  font-family: inherit;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  cursor: pointer;
  max-width: 210px;
  transition: border-color 0.15s;
}

.fce-model-select:focus {
  outline: none;
  border-color: var(--color-accent);
}

.fce-remove-btn {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  border-radius: 3px;
  opacity: 0.6;
  transition: opacity 0.15s;
}

.fce-remove-btn:hover {
  opacity: 1;
}

.fce-arrow {
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.fce-add-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px dashed var(--color-border);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}

.fce-add-btn:hover {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.fce-no-models {
  font-size: 12px;
  color: var(--color-text-muted);
  font-style: italic;
}

.fce-default-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  font-style: italic;
  margin-left: 4px;
}
</style>
