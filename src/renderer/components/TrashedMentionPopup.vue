<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { Trash2, RotateCcw } from 'lucide-vue-next'
import { entityTrashStatus } from '../stores/mentionStore'

type EntityResult = { entity: { name: string } }

const props = defineProps<{
  entityId: string
  anchorRect: DOMRect
}>()

const emit = defineEmits<{
  close: []
  restored: []
}>()

const entityName = ref<string | null>(null)
const isRestoring = ref(false)
const popupRef = ref<HTMLElement | null>(null)

const POPUP_APPROX_HEIGHT = 120

const popupTop = computed(() => {
  const spaceBelow = window.innerHeight - props.anchorRect.bottom
  if (spaceBelow < POPUP_APPROX_HEIGHT + 16) {
    return Math.max(8, props.anchorRect.top - POPUP_APPROX_HEIGHT - 8)
  }
  return props.anchorRect.bottom + 8
})

const popupLeft = computed(() =>
  Math.min(props.anchorRect.left, window.innerWidth - 240)
)

onMounted(async () => {
  document.addEventListener('mousedown', onOutsideClick)
  document.addEventListener('keydown', onEscKey)

  const result = (await window.api.invoke('entities:get', { id: props.entityId })) as EntityResult | null
  if (result) {
    entityName.value = result.entity.name
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutsideClick)
  document.removeEventListener('keydown', onEscKey)
})

function onOutsideClick(e: MouseEvent): void {
  if (popupRef.value && !popupRef.value.contains(e.target as Node)) {
    emit('close')
  }
}

function onEscKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

async function restore(): Promise<void> {
  isRestoring.value = true
  await window.api.invoke('entities:restore', { id: props.entityId })
  entityTrashStatus.set(props.entityId, false)
  isRestoring.value = false
  emit('restored')
  emit('close')
}
</script>

<template>
  <div
    ref="popupRef"
    class="trashed-popup"
    :style="{ top: `${popupTop}px`, left: `${popupLeft}px` }"
  >
    <div class="trashed-popup-header">
      <Trash2 :size="14" class="trashed-icon" />
      <div class="trashed-popup-text">
        <span class="trashed-entity-name">{{ entityName ?? '…' }}</span>
        <span class="trashed-label">This entity is in trash</span>
      </div>
    </div>
    <div class="trashed-popup-actions">
      <button class="btn-restore" :disabled="isRestoring" @click="restore">
        <RotateCcw :size="12" />
        {{ isRestoring ? 'Restoring…' : 'Restore' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.trashed-popup {
  position: fixed;
  z-index: 9998;
  width: 220px;
  background: #252525;
  border: 1px solid #3a2020;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  font-size: 13px;
}

.trashed-popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border-bottom: 1px solid #3a2020;
}

.trashed-icon {
  color: #f06070;
  flex-shrink: 0;
}

.trashed-popup-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.trashed-entity-name {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trashed-label {
  font-size: 11px;
  color: #f06070;
}

.trashed-popup-actions {
  padding: 8px 12px;
}

.btn-restore {
  display: flex;
  align-items: center;
  gap: 5px;
  background: rgba(240, 96, 112, 0.12);
  border: 1px solid #f06070;
  border-radius: 5px;
  color: #f06070;
  font-size: 12px;
  font-family: inherit;
  padding: 5px 12px;
  cursor: pointer;
  transition: background 0.1s;
}

.btn-restore:hover:not(:disabled) {
  background: rgba(240, 96, 112, 0.22);
}

.btn-restore:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
