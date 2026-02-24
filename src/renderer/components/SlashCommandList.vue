<script setup lang="ts">
import { ref, watch } from 'vue'
import LucideIcon from './LucideIcon.vue'

export interface SlashCommandItem {
  id: string
  label: string
  description: string
  icon: string
}

const props = defineProps<{
  items: SlashCommandItem[]
  command: (item: SlashCommandItem) => void
}>()

const selectedIndex = ref(0)

watch(
  () => props.items,
  () => { selectedIndex.value = 0 }
)

function select(index: number): void {
  const item = props.items[index]
  if (item) props.command(item)
}

function onKeyDown(event: KeyboardEvent): boolean {
  if (event.key === 'ArrowUp') {
    selectedIndex.value = (selectedIndex.value - 1 + props.items.length) % props.items.length
    return true
  }
  if (event.key === 'ArrowDown') {
    selectedIndex.value = (selectedIndex.value + 1) % props.items.length
    return true
  }
  if (event.key === 'Enter') {
    select(selectedIndex.value)
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<template>
  <div class="slash-list">
    <template v-if="items.length">
      <button
        v-for="(item, i) in items"
        :key="item.id"
        class="slash-item"
        :class="{ selected: i === selectedIndex }"
        @mousedown.prevent
        @click="select(i)"
      >
        <span class="slash-item-icon"><LucideIcon :name="item.icon" :size="14" /></span>
        <span class="slash-item-label">{{ item.label }}</span>
        <span class="slash-item-desc">{{ item.description }}</span>
      </button>
    </template>
    <div v-else class="slash-empty">No commands</div>
  </div>
</template>

<style scoped>
.slash-list {
  background: var(--color-surface, #242424);
  border: 1px solid var(--color-border, #2e2e2e);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  min-width: 220px;
  max-width: 320px;
  font-size: 13px;
}

.slash-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--color-text, #e8e8e8);
}

.slash-item:hover,
.slash-item.selected {
  background: rgba(91, 141, 239, 0.15);
}

.slash-item-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: var(--color-accent, #5b8def);
}

.slash-item-label {
  flex: 1;
  font-weight: 500;
  white-space: nowrap;
}

.slash-item-desc {
  font-size: 11px;
  color: var(--color-text-muted, #888);
  white-space: nowrap;
}

.slash-empty {
  padding: 8px 12px;
  color: var(--color-text-muted, #888);
  font-size: 12px;
}
</style>
