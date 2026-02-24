<script setup lang="ts">
import { X } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'
import type { Tab, ContentPane } from '../stores/tabStore'

const props = defineProps<{
  tabs: Tab[]
  activeTabId: string
}>()

const emit = defineEmits<{
  'set-active-tab': [id: string]
  'close-tab': [id: string]
}>()

function activePane(tab: Tab): ContentPane | undefined {
  return tab.panes.find((p) => p.id === tab.activePaneId) ?? tab.panes[0]
}
</script>

<template>
  <div class="tab-bar">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      class="tab"
      :class="{ active: tab.id === activeTabId }"
      @click="emit('set-active-tab', tab.id)"
    >
      <span class="tab-icon">
        <LucideIcon
          :name="activePane(tab)?.icon ?? 'file-text'"
          :size="12"
          :color="activePane(tab)?.color ?? undefined"
        />
      </span>
      <span class="tab-label">{{ activePane(tab)?.title || 'Untitled' }}</span>
      <span class="tab-close" @click.stop="emit('close-tab', tab.id)">
        <X :size="11" />
      </span>
    </button>
  </div>
</template>

<style scoped>
.tab-bar {
  display: flex;
  align-items: stretch;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  height: 36px;
  overflow-x: auto;
  flex-shrink: 0;
}

.tab-bar::-webkit-scrollbar {
  height: 0;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px 0 14px;
  border-right: 1px solid var(--color-border);
  background: transparent;
  border-top: none;
  border-left: none;
  border-bottom: none;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  min-width: 80px;
  max-width: 180px;
  flex-shrink: 0;
  white-space: nowrap;
  position: relative;
  transition: background 0.1s, color 0.1s;
}

.tab:hover {
  background: rgba(255, 255, 255, 0.04);
  color: var(--color-text);
}

.tab.active {
  background: var(--color-bg);
  color: var(--color-text);
  box-shadow: inset 0 -2px 0 var(--color-accent);
}

.tab-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  opacity: 0.7;
}

.tab.active .tab-icon {
  opacity: 1;
}

.tab-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}

.tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  opacity: 0;
  flex-shrink: 0;
  transition: opacity 0.1s;
}

.tab:hover .tab-close,
.tab.active .tab-close {
  opacity: 0.5;
}

.tab-close:hover {
  opacity: 1 !important;
  background: rgba(255, 255, 255, 0.12);
}
</style>
