<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, NodeViewContent, nodeViewProps } from '@tiptap/vue-3'
import { PlusSquare, Link2 } from 'lucide-vue-next'
import { firePromote } from '../stores/taskActionStore'

const props = defineProps(nodeViewProps)

const checked = computed(() => props.node.attrs.checked as boolean)
const actionId = computed(() => props.node.attrs.actionId as string | null)

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

async function promote(): Promise<void> {
  await firePromote(props.node.textContent, props.getPos?.() ?? 0)
}
</script>

<template>
  <NodeViewWrapper as="li" data-type="taskItem" :data-checked="checked">
    <button
      v-if="!actionId"
      class="promote-btn"
      title="Add to Actions dashboard"
      @mousedown.prevent
      @click="promote"
    >
      <PlusSquare :size="12" />
    </button>
    <span v-else class="linked-badge" title="Linked to Actions dashboard">
      <Link2 :size="11" />
    </span>
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
.promote-btn,
.linked-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.promote-btn {
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
  color: var(--color-accent);
  opacity: 0.5;
}

li[data-type='taskItem']:hover .linked-badge {
  opacity: 0.9;
}

/* Strike-through text when checked */
li[data-type='taskItem'][data-checked='true'] .task-content {
  text-decoration: line-through;
  opacity: 0.5;
}
</style>
