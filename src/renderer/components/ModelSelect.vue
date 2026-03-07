<script setup lang="ts">
import { computed } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

const props = defineProps<{
  modelValue: string
  models: { id: string; label: string }[]
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const selectedLabel = computed(() => {
  if (!props.modelValue) return 'Default'
  return props.models.find((m) => m.id === props.modelValue)?.label ?? 'Default'
})
</script>

<template>
  <div class="model-select-wrap" :class="{ 'model-select-wrap--disabled': disabled }">
    <span class="model-select-label">{{ selectedLabel }}</span>
    <ChevronDown :size="11" class="model-select-chevron" />
    <!-- Native select overlaid invisibly for interaction/accessibility -->
    <select
      class="model-select-native"
      :value="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option value="">Default</option>
      <option v-for="m in models" :key="m.id" :value="m.id">{{ m.label }}</option>
    </select>
  </div>
</template>

<style scoped>
.model-select-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 26px;
  padding: 0 4px;
  border-radius: 5px;
  flex-shrink: 0;
  transition: background 0.1s;
}

.model-select-wrap:hover:not(.model-select-wrap--disabled) {
  background: var(--color-hover);
}

.model-select-label {
  font-size: 11px;
  font-family: inherit;
  color: var(--color-text-muted);
  white-space: nowrap;
  pointer-events: none;
  user-select: none;
}

.model-select-wrap:hover:not(.model-select-wrap--disabled) .model-select-label {
  color: var(--color-text);
}

.model-select-chevron {
  color: var(--color-text-muted);
  flex-shrink: 0;
  pointer-events: none;
}

.model-select-wrap:hover:not(.model-select-wrap--disabled) .model-select-chevron {
  color: var(--color-text);
}

.model-select-wrap--disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* Invisible overlay — provides the native dropdown interaction */
.model-select-native {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  cursor: pointer;
  border: none;
  background: transparent;
  font-size: 11px;
  font-family: inherit;
}

.model-select-native:disabled {
  cursor: not-allowed;
}
</style>
