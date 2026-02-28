<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpAZ, ArrowDownAZ, Layers } from 'lucide-vue-next'
import ToolbarDropdown from './ToolbarDropdown.vue'

export type FieldOption = { name: string; label: string }

const props = defineProps<{
  sortField: string
  sortDir: 'asc' | 'desc'
  groupField: string | null
  sortableFields: FieldOption[]
  groupableFields: FieldOption[]
}>()

const emit = defineEmits<{
  'update:sortField': [value: string]
  'update:sortDir': [value: 'asc' | 'desc']
  'update:groupField': [value: string | null]
}>()

const BUILTIN_SORT: FieldOption[] = [
  { name: 'name', label: 'Name' },
  { name: 'created_at', label: 'Date created' },
  { name: 'updated_at', label: 'Date updated' },
]

const BUILTIN_GROUP: FieldOption[] = [{ name: 'name', label: 'Name (A–Z)' }]

const allSortOptions = computed<FieldOption[]>(() => {
  if (props.sortableFields.length === 0) return BUILTIN_SORT
  return [...BUILTIN_SORT, ...props.sortableFields]
})

const allGroupOptions = computed<FieldOption[]>(() => {
  if (props.groupableFields.length === 0) return BUILTIN_GROUP
  return [...BUILTIN_GROUP, ...props.groupableFields]
})

const sortLabel = computed<string>(() => {
  const all = [...BUILTIN_SORT, ...props.sortableFields]
  return all.find((o) => o.name === props.sortField)?.label ?? 'Name'
})

const groupLabel = computed<string | null>(() => {
  if (!props.groupField) return null
  const all = [...BUILTIN_GROUP, ...props.groupableFields]
  return all.find((o) => o.name === props.groupField)?.label ?? null
})

function selectSort(field: string): void {
  if (field === props.sortField) {
    emit('update:sortDir', props.sortDir === 'asc' ? 'desc' : 'asc')
  } else {
    emit('update:sortField', field)
    emit('update:sortDir', 'asc')
  }
}

function selectGroup(field: string | null): void {
  emit('update:groupField', field)
}
</script>

<template>
  <div class="sort-bar">
    <!-- Sort dropdown -->
    <ToolbarDropdown :active="sortField !== 'name' || sortDir !== 'asc'">
      <template #label>
        <component :is="sortDir === 'desc' ? ArrowDownAZ : ArrowUpAZ" :size="12" />
        <span class="sort-bar-label">{{ sortLabel }}</span>
      </template>
      <button
        v-for="opt in allSortOptions"
        :key="opt.name"
        class="tb-dropdown-item"
        :class="{ active: sortField === opt.name }"
        @click="selectSort(opt.name)"
      >
        {{ opt.label }}
        <span v-if="sortField === opt.name" class="sort-bar-dir-hint">
          {{ sortDir === 'asc' ? '↑' : '↓' }}
        </span>
      </button>
    </ToolbarDropdown>

    <!-- Group dropdown -->
    <ToolbarDropdown :active="!!groupField">
      <template #label>
        <Layers :size="12" />
        <span class="sort-bar-label">{{ groupLabel ?? 'Group' }}</span>
      </template>
      <button
        class="tb-dropdown-item"
        :class="{ active: !groupField }"
        @click="selectGroup(null)"
      >
        No grouping
      </button>
      <div class="sort-bar-divider" />
      <button
        v-for="opt in allGroupOptions"
        :key="opt.name"
        class="tb-dropdown-item"
        :class="{ active: groupField === opt.name }"
        @click="selectGroup(opt.name)"
      >
        {{ opt.label }}
      </button>
    </ToolbarDropdown>
  </div>
</template>

<style scoped>
.sort-bar {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.sort-bar-label {
  font-size: 11px;
  max-width: 80px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sort-bar-dir-hint {
  margin-left: auto;
  padding-left: 8px;
  font-size: 11px;
  opacity: 0.6;
}

.sort-bar-divider {
  height: 1px;
  background: var(--color-border);
  margin: 4px 0;
}
</style>
