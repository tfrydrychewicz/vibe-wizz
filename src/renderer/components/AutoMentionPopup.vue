<script setup lang="ts">
import { computed } from 'vue'
import LucideIcon from './LucideIcon.vue'
import { cancelHideAutoDetection, scheduleHideAutoDetection } from '../stores/autoMentionStore'
import type { HoveredAutoDetection } from '../stores/autoMentionStore'

const props = defineProps<{
  detection: HoveredAutoDetection
}>()

const emit = defineEmits<{
  insert: [{ entityId: string; entityName: string; from: number; to: number }]
}>()

const POPUP_HEIGHT = 40

const popupTop = computed(() => {
  const spaceBelow = window.innerHeight - props.detection.anchorRect.bottom
  if (spaceBelow < POPUP_HEIGHT + 16) {
    return Math.max(8, props.detection.anchorRect.top - POPUP_HEIGHT - 6)
  }
  return props.detection.anchorRect.bottom + 6
})

const popupLeft = computed(() =>
  Math.min(props.detection.anchorRect.left, window.innerWidth - 260)
)

function insert(): void {
  emit('insert', {
    entityId: props.detection.entityId,
    entityName: props.detection.entityName,
    from: props.detection.from,
    to: props.detection.to,
  })
}
</script>

<template>
  <div
    class="auto-mention-popup"
    :style="{ top: `${popupTop}px`, left: `${popupLeft}px` }"
    @mouseenter="cancelHideAutoDetection"
    @mouseleave="scheduleHideAutoDetection()"
  >
    <span class="amp-icon">
      <LucideIcon
        :name="detection.typeIcon"
        :size="13"
        :color="detection.typeColor ?? undefined"
      />
    </span>
    <span class="amp-name">{{ detection.entityName }}</span>
    <span class="amp-type">{{ detection.typeName }}</span>
    <button class="amp-btn" @mousedown.prevent @click="insert">+ @mention</button>
  </div>
</template>

<style scoped>
.auto-mention-popup {
  position: fixed;
  z-index: 9997;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  background: #252525;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  font-size: 12px;
  white-space: nowrap;
  max-width: 300px;
  pointer-events: all;
}

.amp-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.amp-name {
  font-weight: 600;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.amp-type {
  color: var(--color-text-muted);
  font-size: 11px;
  flex-shrink: 0;
}

.amp-btn {
  margin-left: 4px;
  flex-shrink: 0;
  padding: 3px 7px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-accent);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}

.amp-btn:hover {
  background: rgba(91, 141, 239, 0.1);
  border-color: var(--color-accent);
}
</style>
