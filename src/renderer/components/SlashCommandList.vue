<script setup lang="ts">
import { ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'

export interface SlashCommandItem {
  id: string
  label: string
  description: string
  icon: string
  subItems?: SlashCommandItem[]
}

const props = defineProps<{
  items: SlashCommandItem[]
  command: (item: SlashCommandItem) => void
}>()

const selectedIndex = ref(0)
const subItems = ref<SlashCommandItem[] | null>(null)
const subSelectedIndex = ref(0)

watch(
  () => props.items,
  () => { selectedIndex.value = 0; subItems.value = null }
)

function enterSub(parentIndex: number): void {
  const parent = props.items[parentIndex]
  if (parent?.subItems?.length) {
    subItems.value = parent.subItems
    subSelectedIndex.value = 0
  }
}

function exitSub(): void {
  subItems.value = null
}

function select(index: number): void {
  const item = props.items[index]
  if (!item) return
  if (item.subItems?.length) { enterSub(index); return }
  props.command(item)
}

function selectSub(index: number): void {
  const item = subItems.value?.[index]
  if (item) props.command(item)
}

function onKeyDown(event: KeyboardEvent): boolean {
  if (subItems.value) {
    if (event.key === 'ArrowUp') {
      subSelectedIndex.value = (subSelectedIndex.value - 1 + subItems.value.length) % subItems.value.length
      return true
    }
    if (event.key === 'ArrowDown') {
      subSelectedIndex.value = (subSelectedIndex.value + 1) % subItems.value.length
      return true
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft') { exitSub(); return true }
    if (event.key === 'Enter') { selectSub(subSelectedIndex.value); return true }
    return false
  }
  if (event.key === 'ArrowUp') {
    selectedIndex.value = (selectedIndex.value - 1 + props.items.length) % props.items.length
    return true
  }
  if (event.key === 'ArrowDown') {
    selectedIndex.value = (selectedIndex.value + 1) % props.items.length
    return true
  }
  if (event.key === 'ArrowRight') {
    const item = props.items[selectedIndex.value]
    if (item?.subItems?.length) { enterSub(selectedIndex.value); return true }
    return false
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
    <!-- Sub-command panel -->
    <template v-if="subItems">
      <button class="slash-back" @mousedown.prevent @click="exitSub">
        ← Back
      </button>
      <template v-if="subItems.length">
        <button
          v-for="(item, i) in subItems"
          :key="item.id"
          class="slash-item"
          :class="{ selected: i === subSelectedIndex }"
          @mousedown.prevent
          @click="selectSub(i)"
        >
          <span class="slash-item-icon"><LucideIcon :name="item.icon" :size="14" /></span>
          <span class="slash-item-label">{{ item.label }}</span>
          <span class="slash-item-desc">{{ item.description }}</span>
        </button>
      </template>
    </template>

    <!-- Main command list -->
    <template v-else>
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
          <ChevronRight v-if="item.subItems?.length" :size="12" class="slash-item-chevron" />
        </button>
      </template>
      <div v-else class="slash-empty">No commands</div>
    </template>
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

.slash-back {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 6px 12px;
  background: none;
  border: none;
  border-bottom: 1px solid var(--color-border, #2e2e2e);
  cursor: pointer;
  text-align: left;
  color: var(--color-text-muted, #888);
  font-size: 11px;
  font-family: inherit;
}

.slash-back:hover {
  color: var(--color-text, #e8e8e8);
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

.slash-item-chevron {
  color: var(--color-text-muted, #888);
  flex-shrink: 0;
}

.slash-empty {
  padding: 8px 12px;
  color: var(--color-text-muted, #888);
  font-size: 12px;
}
</style>
