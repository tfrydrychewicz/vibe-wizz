<script setup lang="ts">
import { computed } from 'vue'
import { Folder, Tag, Zap, Clock, X } from 'lucide-vue-next'

export type ChipType = 'project' | 'context' | 'energy' | 'waiting'

const props = withDefaults(
  defineProps<{
    type: ChipType
    label: string
    removable?: boolean
    /** Required when type === 'energy' to set the correct colour. */
    energyLevel?: 'low' | 'medium' | 'high' | null
  }>(),
  { removable: false, energyLevel: null },
)

const emit = defineEmits<{ remove: [] }>()

const config = computed(() => {
  switch (props.type) {
    case 'project':
      return { icon: Folder, color: '#f0a050', bg: 'rgba(240,160,80,0.12)' }
    case 'context':
      return { icon: Tag, color: '#6b7280', bg: 'rgba(107,114,128,0.12)' }
    case 'energy': {
      const map = {
        low:    { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)' },
        medium: { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
        high:   { color: 'var(--color-danger)', bg: 'var(--color-danger-subtle)' },
      }
      const c = props.energyLevel ? map[props.energyLevel] : map.medium
      return { icon: Zap, ...c }
    }
    case 'waiting':
      return { icon: Clock, color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' }
  }
})
</script>

<template>
  <span class="chip" :style="{ '--chip-color': config.color, '--chip-bg': config.bg }">
    <component :is="config.icon" :size="10" class="chip-icon" />
    <span class="chip-label">{{ label }}</span>
    <button v-if="removable" class="chip-remove" @click.stop="emit('remove')">
      <X :size="9" />
    </button>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--chip-bg);
  color: var(--chip-color);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.chip-icon {
  flex-shrink: 0;
  opacity: 0.8;
}

.chip-label {
  line-height: 1.2;
}

.chip-remove {
  display: inline-flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--chip-color);
  cursor: pointer;
  padding: 0;
  opacity: 0.55;
  margin-left: 1px;
}

.chip-remove:hover {
  opacity: 1;
}
</style>
