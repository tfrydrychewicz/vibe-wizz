<script setup lang="ts">
import { ref, onMounted } from 'vue'
import LucideIcon from './LucideIcon.vue'
import { Trash2, RotateCcw } from 'lucide-vue-next'
import { entityTrashStatus } from '../stores/mentionStore'

type TrashedNote = {
  id: string
  title: string
  archived_at: string
}

type TrashedEntity = {
  id: string
  name: string
  trashed_at: string
  type_id: string
  type_name: string
  type_icon: string
  type_color: string | null
}

type TrashList = {
  notes: TrashedNote[]
  entities: TrashedEntity[]
}

const data = ref<TrashList>({ notes: [], entities: [] })

// { id, mentionCount } when awaiting confirmation before deleting an entity forever
const pendingDeleteForever = ref<{ id: string; mentionCount: number } | null>(null)

async function load(): Promise<void> {
  data.value = (await window.api.invoke('trash:list')) as TrashList
}

async function restoreNote(id: string): Promise<void> {
  await window.api.invoke('notes:restore', { id })
  await load()
}

async function deleteNoteForever(id: string): Promise<void> {
  await window.api.invoke('notes:delete-forever', { id })
  await load()
}

async function restoreEntity(id: string): Promise<void> {
  await window.api.invoke('entities:restore', { id })
  entityTrashStatus.set(id, false)
  await load()
}

async function requestDeleteEntityForever(id: string): Promise<void> {
  const { count } = (await window.api.invoke('entities:get-mention-count', { id })) as { count: number }
  if (count > 0) {
    pendingDeleteForever.value = { id, mentionCount: count }
  } else {
    await finishDeleteEntityForever(id)
  }
}

async function finishDeleteEntityForever(id: string): Promise<void> {
  pendingDeleteForever.value = null
  await window.api.invoke('entities:delete-forever', { id })
  entityTrashStatus.delete(id)
  await load()
}

function cancelDeleteForever(): void {
  pendingDeleteForever.value = null
}

function formatDate(isoString: string): string {
  return new Date(isoString).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

onMounted(load)
</script>

<template>
  <div class="trash-view">
    <div class="trash-header">
      <h1 class="trash-title">
        <Trash2 :size="16" class="trash-title-icon" />
        Trash
      </h1>
    </div>

    <div class="trash-body">
      <div v-if="data.notes.length === 0 && data.entities.length === 0" class="trash-empty">
        <Trash2 :size="40" class="trash-empty-icon" />
        <p>Trash is empty</p>
      </div>

      <template v-else>
        <!-- Notes section -->
        <div v-if="data.notes.length > 0" class="trash-section">
          <div class="trash-section-label">Notes</div>
          <div v-for="note in data.notes" :key="note.id" class="trash-row">
            <LucideIcon name="file-text" :size="14" class="trash-row-icon" />
            <span class="trash-row-name">{{ note.title || 'Untitled' }}</span>
            <span class="trash-row-date">{{ formatDate(note.archived_at) }}</span>
            <div class="trash-row-actions">
              <button class="trash-action-btn" title="Restore" @click="restoreNote(note.id)">
                <RotateCcw :size="12" /> Restore
              </button>
              <button class="trash-action-btn trash-action-delete" title="Delete forever" @click="deleteNoteForever(note.id)">
                <Trash2 :size="12" /> Delete forever
              </button>
            </div>
          </div>
        </div>

        <!-- Entities section -->
        <div v-if="data.entities.length > 0" class="trash-section">
          <div class="trash-section-label">Entities</div>

          <template v-for="entity in data.entities" :key="entity.id">
            <!-- Delete-forever confirmation row -->
            <div
              v-if="pendingDeleteForever && pendingDeleteForever.id === entity.id"
              class="trash-row delete-confirm-row"
            >
              <LucideIcon
                :name="entity.type_icon"
                :size="14"
                :color="entity.type_color ?? undefined"
                class="trash-row-icon"
              />
              <div class="delete-confirm-body">
                <span class="delete-confirm-name">{{ entity.name }}</span>
                <span class="delete-confirm-msg">
                  Mentioned in {{ pendingDeleteForever.mentionCount }}
                  {{ pendingDeleteForever.mentionCount === 1 ? 'note' : 'notes' }}.
                  Mentions will be replaced with plain text. Delete forever?
                </span>
              </div>
              <div class="trash-row-actions">
                <button class="trash-action-btn trash-action-delete" @click="finishDeleteEntityForever(entity.id)">
                  <Trash2 :size="12" /> Delete forever
                </button>
                <button class="trash-action-btn" @click="cancelDeleteForever">
                  Cancel
                </button>
              </div>
            </div>

            <!-- Normal entity row -->
            <div v-else class="trash-row">
              <LucideIcon
                :name="entity.type_icon"
                :size="14"
                :color="entity.type_color ?? undefined"
                class="trash-row-icon"
              />
              <div class="trash-row-names">
                <span class="trash-row-name">{{ entity.name }}</span>
                <span class="trash-row-type">{{ entity.type_name }}</span>
              </div>
              <span class="trash-row-date">{{ formatDate(entity.trashed_at) }}</span>
              <div class="trash-row-actions">
                <button class="trash-action-btn" title="Restore" @click="restoreEntity(entity.id)">
                  <RotateCcw :size="12" /> Restore
                </button>
                <button class="trash-action-btn trash-action-delete" title="Delete forever" @click="requestDeleteEntityForever(entity.id)">
                  <Trash2 :size="12" /> Delete forever
                </button>
              </div>
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.trash-view {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg);
}

.trash-header {
  padding: 16px 24px 12px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.trash-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.trash-title-icon {
  color: var(--color-text-muted);
}

.trash-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
}

.trash-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 200px;
  gap: 12px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.trash-empty-icon {
  opacity: 0.3;
}

.trash-section {
  margin-bottom: 28px;
}

.trash-section-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 8px;
}

.trash-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
}

.trash-row:last-child {
  border-bottom: none;
}

.trash-row-icon {
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.trash-row-names {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.trash-row-name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 13px;
  color: var(--color-text);
}

.trash-row-type {
  font-size: 11px;
  color: var(--color-text-muted);
}

.trash-row-date {
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.trash-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.trash-action-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.1s, color 0.1s, border-color 0.1s;
  white-space: nowrap;
}

.trash-action-btn:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--color-text);
}

.trash-action-delete:hover {
  background: rgba(240, 96, 112, 0.12);
  color: #f06070;
  border-color: rgba(240, 96, 112, 0.4);
}

/* Delete-forever confirmation row */
.delete-confirm-row {
  align-items: flex-start;
  background: rgba(240, 96, 112, 0.05);
  border-radius: 6px;
  padding: 10px 8px;
  border-bottom: none;
  margin-bottom: 1px;
  gap: 10px;
}

.delete-confirm-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.delete-confirm-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.delete-confirm-msg {
  font-size: 12px;
  color: #f06070;
  line-height: 1.4;
}
</style>
