<script setup lang="ts">
import { ref, watch } from 'vue'

export interface MentionItem {
  id: string
  name: string
  type_name: string
  type_icon: string
}

const props = defineProps<{
  items: MentionItem[]
  command: (attrs: { id: string; label: string }) => void
}>()

const selectedIndex = ref(0)

watch(
  () => props.items,
  () => { selectedIndex.value = 0 }
)

function select(index: number) {
  const item = props.items[index]
  if (item) {
    props.command({ id: item.id, label: item.name })
  }
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
  <div class="mention-list">
    <template v-if="items.length">
      <button
        v-for="(item, i) in items"
        :key="item.id"
        class="mention-item"
        :class="{ selected: i === selectedIndex }"
        @mousedown.prevent
        @click="select(i)"
      >
        <span class="mention-item-icon">{{ item.type_icon }}</span>
        <span class="mention-item-name">{{ item.name }}</span>
        <span class="mention-item-type">{{ item.type_name }}</span>
      </button>
    </template>
    <div v-else class="mention-empty">No results</div>
  </div>
</template>

<style scoped>
.mention-list {
  background: var(--color-surface, #242424);
  border: 1px solid var(--color-border, #2e2e2e);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  min-width: 200px;
  max-width: 300px;
  max-height: 240px;
  overflow-y: auto;
  font-size: 13px;
}

.mention-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--color-text, #e8e8e8);
}

.mention-item:hover,
.mention-item.selected {
  background: rgba(91, 141, 239, 0.15);
}

.mention-item-icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
}

.mention-item-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-item-type {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted, #888);
}

.mention-empty {
  padding: 8px 10px;
  color: var(--color-text-muted, #888);
  font-size: 12px;
}
</style>
