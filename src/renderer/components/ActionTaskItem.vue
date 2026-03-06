<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, NodeViewContent, nodeViewProps } from '@tiptap/vue-3'
import { PlusSquare, Loader2 } from 'lucide-vue-next'
import { firePromote } from '../stores/taskActionStore'
import { taskDataCache, derivingIds, fireShowInlineDetail } from '../stores/taskInlineDetailStore'

const props = defineProps(nodeViewProps)

const checked = computed(() => props.node.attrs.checked as boolean)
const actionId = computed(() => props.node.attrs.actionId as string | null)
const taskSummary = computed(() => actionId.value ? taskDataCache.get(actionId.value) : null)
const isDerivingNow = computed(() => actionId.value ? derivingIds.has(actionId.value) : false)

const statusDotClass = computed(() => {
  const map: Record<string, string> = {
    open: 'dot-open',
    in_progress: 'dot-progress',
    done: 'dot-done',
    cancelled: 'dot-cancelled',
    someday: 'dot-someday',
  }
  return map[taskSummary.value?.status ?? 'open'] ?? 'dot-open'
})

function onBadgeClick(e: MouseEvent): void {
  if (!actionId.value) return
  fireShowInlineDetail(actionId.value, (e.currentTarget as HTMLElement).getBoundingClientRect())
}

function toggleChecked(): void {
  const newChecked = !checked.value
  props.updateAttributes({ checked: newChecked })
  if (actionId.value) {
    void window.api.invoke('action-items:update', {
      id: actionId.value,
      status: newChecked ? 'done' : 'open',
    })
  }
}

// Walk the node tree to extract text, substituting mention/noteLink atoms
// with their label attribute (node.textContent returns "" for atom nodes).
type PMNode = { isText?: boolean; text?: string; type: { name: string }; attrs: Record<string, unknown>; forEach: (fn: (child: PMNode) => void) => void }
function extractText(node: PMNode): string {
  if (node.isText) return node.text ?? ''
  if (node.type.name === 'mention' || node.type.name === 'noteLink') {
    return (node.attrs.label as string | undefined) ?? ''
  }
  let out = ''
  node.forEach((child) => { out += extractText(child) })
  return out
}

async function promote(e: MouseEvent): Promise<void> {
  const text = extractText(props.node as unknown as PMNode).trim()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  await firePromote(text, props.getPos?.() ?? 0, rect)
}
</script>

<template>
  <NodeViewWrapper as="li" data-type="taskItem" :data-checked="checked">
    <button
      v-if="!actionId"
      class="promote-btn"
      title="Add to Actions dashboard"
      @mousedown.prevent
      @click="promote($event)"
    >
      <PlusSquare :size="12" />
    </button>
    <button
      v-else
      class="linked-badge"
      :class="{ 'linked-badge--deriving': isDerivingNow }"
      :title="isDerivingNow ? 'AI is deriving attributes…' : 'View in Actions dashboard'"
      :disabled="isDerivingNow"
      @mousedown.prevent
      @click="onBadgeClick"
    >
      <Loader2 v-if="isDerivingNow" :size="10" class="badge-spinner" />
      <template v-else>
        <span class="status-dot" :class="statusDotClass" />
        <span v-if="taskSummary?.project_name" class="badge-project">{{ taskSummary.project_name }}</span>
        <span v-if="taskSummary?.due_date" class="badge-due">{{ taskSummary.due_date }}</span>
      </template>
    </button>
    <label contenteditable="false" class="task-label">
      <input class="task-checkbox" type="checkbox" :checked="checked" @change="toggleChecked" />
    </label>
    <NodeViewContent as="div" class="task-content" />
  </NodeViewWrapper>
</template>

<style scoped>
/* NodeViewWrapper renders as <li data-type="taskItem"> — mirrors TipTap's default TaskItem HTML */
li[data-type='taskItem'] {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
}

li[data-type='taskItem'] > label {
  flex-shrink: 0;
  cursor: pointer;
  display: flex;
  align-items: center;
}

.task-content {
  flex: 1;
  min-width: 0;
}

/* Strip paragraph margins inserted by TipTap inside NodeViewContent */
.task-content :deep(p) {
  margin: 0;
}

/* Both the promote button and linked badge occupy the same fixed slot
   so that checkboxes are always horizontally aligned */
.promote-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  border-radius: 4px;
  padding: 0;
  cursor: pointer;
}

.promote-btn:hover {
  background: var(--color-hover);
  color: var(--color-accent);
  border-color: var(--color-accent);
}

.linked-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  padding: 1px 5px;
  cursor: pointer;
  font-family: inherit;
  font-size: 10px;
  color: var(--color-text-muted);
  opacity: 0.6;
  max-width: 120px;
  overflow: hidden;
  height: 18px;
}

li[data-type='taskItem']:hover .linked-badge {
  opacity: 1;
  border-color: var(--color-accent);
}

.linked-badge:hover:not(:disabled) {
  background: var(--color-hover);
}

.linked-badge--deriving {
  opacity: 0.5 !important;
  cursor: default;
  border-color: var(--color-border) !important;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.badge-spinner {
  animation: spin 1s linear infinite;
  flex-shrink: 0;
}

.status-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-open      { background: #6b7280; }
.dot-progress  { background: #f59e0b; }
.dot-done      { background: #22c55e; }
.dot-cancelled { background: #9ca3af; }
.dot-someday   { background: #8b5cf6; }

.badge-project {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60px;
}

.badge-due {
  flex-shrink: 0;
  opacity: 0.7;
}

/* Strike-through text when checked */
li[data-type='taskItem'][data-checked='true'] .task-content {
  text-decoration: line-through;
  opacity: 0.5;
}
</style>
