<script setup lang="ts">
import { ref, computed } from 'vue'
import * as icons from 'lucide-vue-next'

type IconEntry = { pascal: string; kebab: string }

const props = defineProps<{
  modelValue: string
  color?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [string]
}>()

// Build sorted list of all Lucide icon names at module load time
const ALL_ICONS: IconEntry[] = Object.keys(icons)
  .filter((k) => /^[A-Z]/.test(k))
  .map((k) => ({
    pascal: k,
    // PascalCase → kebab-case, treating number boundaries as word breaks
    kebab: k
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
      .replace(/([a-z])([A-Z])/g, '$1-$2')
      .replace(/([a-zA-Z])([0-9])/g, '$1-$2')
      .replace(/([0-9])([a-zA-Z])/g, '$1-$2')
      .toLowerCase(),
  }))
  .sort((a, b) => a.kebab.localeCompare(b.kebab))

const search = ref('')

const filtered = computed<IconEntry[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return ALL_ICONS.slice(0, 96)
  return ALL_ICONS.filter((ic) => ic.kebab.includes(q)).slice(0, 96)
})

function getComponent(pascal: string) {
  return (icons[pascal as keyof typeof icons] as unknown) ?? icons.Tag
}

// Accent hex (matches --color-accent) used when no color prop provided
const ACCENT = '#5b8def'
</script>

<template>
  <div class="icon-picker">
    <input
      v-model="search"
      class="icon-picker-search"
      type="text"
      placeholder="Search icons…"
    />
    <div class="icon-picker-grid">
      <button
        v-for="ic in filtered"
        :key="ic.pascal"
        class="icon-picker-btn"
        :class="{ selected: modelValue === ic.kebab }"
        :title="ic.kebab"
        @click="emit('update:modelValue', ic.kebab)"
      >
        <component
          :is="getComponent(ic.pascal)"
          :size="16"
          :color="modelValue === ic.kebab ? (color ?? ACCENT) : undefined"
        />
      </button>
    </div>
  </div>
</template>

<style scoped>
.icon-picker {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.icon-picker-search {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text);
  font-size: 12px;
  padding: 6px 10px;
  outline: none;
  font-family: inherit;
  width: 100%;
  transition: border-color 0.15s;
}

.icon-picker-search:focus {
  border-color: var(--color-accent);
}

.icon-picker-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: 2px;
  max-height: 160px;
  overflow-y: auto;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 5px;
}

.icon-picker-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 7px;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-muted);
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}

.icon-picker-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
}

.icon-picker-btn.selected {
  background: rgba(91, 141, 239, 0.15);
  border-color: var(--color-accent);
  color: var(--color-accent);
}
</style>
