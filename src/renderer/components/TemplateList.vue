<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Trash2 } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'

type TemplateListItem = {
  id: string
  name: string
  icon: string
}

const props = defineProps<{ activeTemplateId: string | null }>()
const emit = defineEmits<{
  select: [id: string]
  'new-template': []
}>()

const templates = ref<TemplateListItem[]>([])
const pendingDelete = ref<string | null>(null)

async function refresh(): Promise<void> {
  templates.value = (await window.api.invoke('templates:list')) as TemplateListItem[]
}

function onItemClick(id: string): void {
  pendingDelete.value = null
  emit('select', id)
}

async function confirmDelete(id: string): Promise<void> {
  await window.api.invoke('templates:delete', { id })
  pendingDelete.value = null
  if (props.activeTemplateId === id) emit('select', '')
  await refresh()
}

onMounted(refresh)
defineExpose({ refresh })
</script>

<template>
  <div class="template-list-pane">
    <div class="template-list-header">
      <button class="template-list-new-btn" @click="emit('new-template')">
        <Plus :size="14" />
        New Template
      </button>
    </div>

    <div class="template-list-scroll">
      <div
        v-for="tmpl in templates"
        :key="tmpl.id"
        class="template-list-item"
        :class="{ active: tmpl.id === activeTemplateId, 'is-confirming': pendingDelete === tmpl.id }"
        @click="pendingDelete === tmpl.id ? undefined : onItemClick(tmpl.id)"
      >
        <template v-if="pendingDelete === tmpl.id">
          <div class="delete-confirm" @click.stop>
            <span class="delete-confirm-msg">Delete this template?</span>
            <div class="delete-confirm-btns">
              <button class="delete-confirm-yes" @click="confirmDelete(tmpl.id)">Delete</button>
              <button class="delete-confirm-no" @click="pendingDelete = null">Cancel</button>
            </div>
          </div>
        </template>

        <template v-else>
          <span class="template-item-icon">
            <LucideIcon :name="tmpl.icon || 'file-text'" :size="13" />
          </span>
          <span class="template-item-name">{{ tmpl.name || 'Untitled' }}</span>
          <button
            class="template-item-delete"
            title="Delete template"
            @click.stop="pendingDelete = tmpl.id"
          >
            <Trash2 :size="13" />
          </button>
        </template>
      </div>

      <div v-if="templates.length === 0" class="template-list-empty">
        No templates yet
      </div>
    </div>
  </div>
</template>

<style scoped>
.template-list-pane {
  width: 240px;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface);
  overflow: hidden;
}

.template-list-header {
  padding: 10px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.template-list-new-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  background: rgba(91, 141, 239, 0.12);
  border: 1px solid rgba(91, 141, 239, 0.3);
  border-radius: 6px;
  color: #5b8def;
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.1s;
}

.template-list-new-btn:hover {
  background: rgba(91, 141, 239, 0.2);
}

.template-list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.template-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  cursor: pointer;
  border-radius: 6px;
  margin: 1px 4px;
  position: relative;
}

.template-list-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.template-list-item.active {
  background: rgba(91, 141, 239, 0.12);
}

.template-list-item.is-confirming {
  cursor: default;
  padding: 0;
  margin: 2px 4px;
}

.template-item-icon {
  display: flex;
  align-items: center;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.template-list-item.active .template-item-icon {
  color: #5b8def;
}

.template-item-name {
  flex: 1;
  font-size: 13px;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.template-list-item.active .template-item-name {
  color: var(--color-text);
}

.template-item-delete {
  display: none;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}

.template-list-item:hover .template-item-delete {
  display: flex;
}

.template-item-delete:hover {
  color: #f06070;
}

.template-list-empty {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: center;
  opacity: 0.6;
}

.delete-confirm {
  width: 100%;
  padding: 10px 10px 10px 12px;
  background: var(--color-surface);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.delete-confirm-msg {
  font-size: 12px;
  color: #f06070;
  line-height: 1.4;
}

.delete-confirm-btns {
  display: flex;
  gap: 5px;
}

.delete-confirm-yes,
.delete-confirm-no {
  font-size: 11px;
  font-family: inherit;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  flex: 1;
}

.delete-confirm-yes {
  background: rgba(240, 96, 112, 0.15);
  border: 1px solid rgba(240, 96, 112, 0.5);
  color: #f06070;
}

.delete-confirm-yes:hover {
  background: rgba(240, 96, 112, 0.25);
}

.delete-confirm-no {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

.delete-confirm-no:hover {
  color: var(--color-text);
}
</style>
