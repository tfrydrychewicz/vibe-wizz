<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { FileText, Plus } from 'lucide-vue-next'

export interface NoteLinkItem {
  id: string
  title: string
}

const props = defineProps<{
  items: NoteLinkItem[]
  query: string
  command: (attrs: { id: string; label: string }) => void
}>()

const selectedIndex = ref(0)

const showCreate = computed(
  () =>
    props.query.trim().length > 0 &&
    !props.items.some((i) => i.title.toLowerCase() === props.query.trim().toLowerCase())
)

const totalCount = computed(() => props.items.length + (showCreate.value ? 1 : 0))

watch(
  () => props.items,
  () => { selectedIndex.value = 0 }
)

async function select(index: number): Promise<void> {
  if (index < props.items.length) {
    const item = props.items[index]
    if (item) props.command({ id: item.id, label: item.title })
  } else if (showCreate.value) {
    const title = props.query.trim()
    const note = (await window.api.invoke('notes:create', { title })) as { id: string; title: string }
    props.command({ id: note.id, label: note.title })
  }
}

function onKeyDown(event: KeyboardEvent): boolean {
  if (event.key === 'ArrowUp') {
    selectedIndex.value = (selectedIndex.value - 1 + totalCount.value) % totalCount.value
    return true
  }
  if (event.key === 'ArrowDown') {
    selectedIndex.value = (selectedIndex.value + 1) % totalCount.value
    return true
  }
  if (event.key === 'Enter') {
    void select(selectedIndex.value)
    return true
  }
  return false
}

defineExpose({ onKeyDown })
</script>

<template>
  <div class="note-link-list">
    <template v-if="totalCount > 0">
      <button
        v-for="(item, i) in items"
        :key="item.id"
        class="note-link-item"
        :class="{ selected: i === selectedIndex }"
        @mousedown.prevent
        @click="select(i)"
      >
        <span class="note-link-item-icon"><FileText :size="14" /></span>
        <span class="note-link-item-title">{{ item.title }}</span>
      </button>
      <button
        v-if="showCreate"
        class="note-link-item note-link-create"
        :class="{ selected: selectedIndex === items.length }"
        @mousedown.prevent
        @click="select(items.length)"
      >
        <span class="note-link-item-icon"><Plus :size="14" /></span>
        <span class="note-link-item-title">Create "{{ query.trim() }}"</span>
      </button>
    </template>
    <div v-else class="note-link-empty">No notes found</div>
  </div>
</template>

<style scoped>
.note-link-list {
  background: var(--color-surface, #242424);
  border: 1px solid var(--color-border, #2e2e2e);
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  overflow: hidden;
  min-width: 200px;
  max-width: 320px;
  max-height: 240px;
  overflow-y: auto;
  font-size: 13px;
}

.note-link-item {
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

.note-link-item:hover,
.note-link-item.selected {
  background: rgba(80, 192, 160, 0.15);
}

.note-link-item-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  color: #50c0a0;
}

.note-link-create .note-link-item-icon {
  color: var(--color-text-muted, #888);
}

.note-link-create {
  color: var(--color-text-muted, #888);
  border-top: 1px solid var(--color-border, #2e2e2e);
  font-style: italic;
}

.note-link-create:hover,
.note-link-create.selected {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text, #e8e8e8);
}

.note-link-item-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note-link-empty {
  padding: 8px 10px;
  color: var(--color-text-muted, #888);
  font-size: 12px;
}
</style>
