<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import LucideIcon from './LucideIcon.vue'

type FieldDef = { name: string; type: string; options?: string[] }
type EntityData = {
  entity: { id: string; name: string; type_id: string; fields: string }
  entityType: { id: string; name: string; icon: string; schema: string; color: string | null }
}

const props = defineProps<{
  entityId: string
  anchorRect: DOMRect
}>()

const emit = defineEmits<{
  close: []
  'open-entity': [{ entityId: string; typeId: string }]
}>()

const data = ref<EntityData | null>(null)
const failed = ref(false)
const popupRef = ref<HTMLElement | null>(null)

const POPUP_APPROX_HEIGHT = 220

const popupTop = computed(() => {
  const spaceBelow = window.innerHeight - props.anchorRect.bottom
  if (spaceBelow < POPUP_APPROX_HEIGHT + 16) {
    return Math.max(8, props.anchorRect.top - POPUP_APPROX_HEIGHT - 8)
  }
  return props.anchorRect.bottom + 8
})

const popupLeft = computed(() =>
  Math.min(props.anchorRect.left, window.innerWidth - 288)
)

const fields = computed<Array<{ label: string; value: string }>>(() => {
  if (!data.value) return []
  let schemaDef: { fields: FieldDef[] } = { fields: [] }
  let values: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(data.value.entityType.schema)
    if (parsed && Array.isArray(parsed.fields)) schemaDef = parsed as { fields: FieldDef[] }
  } catch { /* ignore malformed schema */ }
  try {
    values = JSON.parse(data.value.entity.fields) as Record<string, unknown>
  } catch { /* ignore malformed fields */ }

  return schemaDef.fields
    .filter((f) => values[f.name] != null && values[f.name] !== '')
    .map((f) => ({
      label: f.name.replace(/_/g, ' '),
      value: Array.isArray(values[f.name])
        ? (values[f.name] as unknown[]).filter(Boolean).join(', ')
        : String(values[f.name]),
    }))
})

onMounted(async () => {
  // Attach listeners first so the popup is always dismissible
  document.addEventListener('mousedown', onOutsideClick)
  document.addEventListener('keydown', onEscKey)

  try {
    const result = await window.api.invoke('entities:get', { id: props.entityId })
    if (result) {
      data.value = result as EntityData
    } else {
      failed.value = true
    }
  } catch (err) {
    console.error('[EntityMentionPopup] entities:get error:', err)
    failed.value = true
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

function openEntity(): void {
  if (!data.value) return
  emit('open-entity', { entityId: props.entityId, typeId: data.value.entityType.id })
  emit('close')
}
</script>

<template>
  <div
    ref="popupRef"
    class="entity-popup"
    :style="{ top: `${popupTop}px`, left: `${popupLeft}px` }"
  >
    <template v-if="data">
      <div class="entity-popup-header">
        <span class="entity-popup-icon">
          <LucideIcon :name="data.entityType.icon" :size="18" :color="data.entityType.color ?? undefined" />
        </span>
        <div class="entity-popup-titles">
          <span class="entity-popup-name">{{ data.entity.name }}</span>
          <span class="entity-popup-type">{{ data.entityType.name }}</span>
        </div>
        <button class="entity-popup-open-btn" @click="openEntity">Open →</button>
      </div>
      <div v-if="fields.length" class="entity-popup-fields">
        <div v-for="field in fields" :key="field.label" class="entity-popup-field">
          <span class="entity-popup-field-label">{{ field.label }}</span>
          <span class="entity-popup-field-value">{{ field.value }}</span>
        </div>
      </div>
    </template>
    <div v-else-if="failed" class="entity-popup-status">Entity not found</div>
    <div v-else class="entity-popup-status">Loading…</div>
  </div>
</template>

<style scoped>
.entity-popup {
  position: fixed;
  z-index: 9998;
  width: 280px;
  background: #252525;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  font-size: 13px;
}

.entity-popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 12px 10px;
  border-bottom: 1px solid var(--color-border);
}

.entity-popup-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.entity-popup-titles {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entity-popup-name {
  font-weight: 600;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.entity-popup-type {
  font-size: 11px;
  color: var(--color-text-muted);
}

.entity-popup-open-btn {
  flex-shrink: 0;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-accent);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.1s, border-color 0.1s;
}

.entity-popup-open-btn:hover {
  background: rgba(91, 141, 239, 0.1);
  border-color: var(--color-accent);
}

.entity-popup-fields {
  padding: 8px 12px 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 180px;
  overflow-y: auto;
}

.entity-popup-field {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
}

.entity-popup-field-label {
  flex-shrink: 0;
  color: var(--color-text-muted);
  min-width: 64px;
  text-transform: capitalize;
}

.entity-popup-field-value {
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entity-popup-status {
  padding: 16px 12px;
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
