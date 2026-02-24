<script setup lang="ts">
import { ref, onMounted, defineExpose, watch } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'

type EntityListItem = {
  id: string
  name: string
  type_id: string
  updated_at: string
  created_at: string
}

const props = defineProps<{
  typeId: string
  typeName: string
  activeEntityId: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  'new-entity': []
}>()

const entities = ref<EntityListItem[]>([])

async function refresh(): Promise<void> {
  entities.value = (await window.api.invoke('entities:list', {
    type_id: props.typeId,
  })) as EntityListItem[]
}

async function deleteEntity(id: string): Promise<void> {
  await window.api.invoke('entities:delete', { id })
  await refresh()
  if (props.activeEntityId === id) {
    emit('select', entities.value.length > 0 ? entities.value[0].id : '')
  }
}

function formatDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  const diffHour = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHour / 24)

  if (diffSec < 60) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHour < 24) return `${diffHour}h ago`
  if (diffDay === 1) return 'yesterday'
  if (diffDay < 7) return `${diffDay}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

onMounted(refresh)
watch(() => props.typeId, refresh)
defineExpose({ refresh })
</script>

<template>
  <div class="note-list-pane">
    <div class="note-list-header">
      <button class="note-list-new-btn" @click="emit('new-entity')">
        <Plus :size="14" />
        New {{ typeName }}
      </button>
    </div>

    <div class="note-list-scroll">
      <div
        v-for="entity in entities"
        :key="entity.id"
        class="note-list-item"
        :class="{ active: entity.id === activeEntityId }"
        @click="emit('select', entity.id)"
      >
        <div class="note-list-item-body">
          <div class="note-list-item-title">{{ entity.name || 'Untitled' }}</div>
          <div class="note-list-item-date">{{ formatDate(entity.updated_at) }}</div>
        </div>
        <button
          class="note-list-item-delete"
          title="Delete"
          @click.stop="deleteEntity(entity.id)"
        >
          <Trash2 :size="13" />
        </button>
      </div>

      <div v-if="entities.length === 0" class="note-list-empty">
        No {{ typeName.toLowerCase() }}s yet
      </div>
    </div>
  </div>
</template>
