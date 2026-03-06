<script setup lang="ts">
import { ref } from 'vue'
import { X } from 'lucide-vue-next'
import type { ActionItem } from './TaskCard.vue'

const props = defineProps<{
  parentId: string
  sourceNoteId?: string | null
}>()

const emit = defineEmits<{
  created: [task: ActionItem]
  cancel: []
}>()

const inputRef = ref<HTMLInputElement | null>(null)
const title = ref('')
const saving = ref(false)

async function submit(): Promise<void> {
  const t = title.value.trim()
  if (!t || saving.value) return
  saving.value = true
  try {
    const task = (await window.api.invoke('action-items:create', {
      title: t,
      parent_id: props.parentId,
      source_note_id: props.sourceNoteId ?? null,
    })) as ActionItem
    title.value = ''
    emit('created', task)
  } finally {
    saving.value = false
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { e.preventDefault(); void submit() }
  else if (e.key === 'Escape') emit('cancel')
}

function focus(): void {
  inputRef.value?.focus()
}

defineExpose({ focus })
</script>

<template>
  <div class="subtask-input">
    <input
      ref="inputRef"
      v-model="title"
      class="input"
      placeholder="Sub-task title…"
      :disabled="saving"
      autocomplete="off"
      @keydown="onKeydown"
    />
    <button class="btn-cancel" title="Cancel" @click="emit('cancel')">
      <X :size="12" />
    </button>
  </div>
</template>

<style scoped>
.subtask-input {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px 5px 32px; /* left-indent aligns with parent checkbox */
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
}

.input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
}

.input::placeholder {
  color: var(--color-text-muted);
}

.input:disabled {
  opacity: 0.5;
}

.btn-cancel {
  display: flex;
  align-items: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px;
  border-radius: 3px;
  flex-shrink: 0;
}

.btn-cancel:hover {
  color: var(--color-text);
  background: var(--color-hover);
}
</style>
