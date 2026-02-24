<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Archive } from 'lucide-vue-next'
import { noteArchivedStatus, fireNoteLinkClick } from '../stores/noteLinkStore'

const props = defineProps(nodeViewProps)

const id = computed(() => props.node.attrs.id as string)
const label = computed(() => props.node.attrs.label as string)
const isArchived = computed(() => noteArchivedStatus.get(id.value) === true)

function onClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  fireNoteLinkClick(id.value, el.getBoundingClientRect())
}
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="note-link"
    :class="{ 'note-link-archived': isArchived }"
    :data-id="id"
    @click.stop="onClick"
  >
    <Archive v-if="isArchived" :size="10" class="note-link-archive-icon" />[[{{ label }}]]
  </NodeViewWrapper>
</template>

<style scoped>
.note-link {
  background: rgba(80, 192, 160, 0.15);
  border-radius: 3px;
  color: #50c0a0;
  font-weight: 500;
  padding: 1px 3px;
  white-space: nowrap;
  cursor: pointer;
  display: inline;
}

.note-link:hover {
  background: rgba(80, 192, 160, 0.25);
}

.note-link-archived {
  color: #888888;
  background: rgba(136, 136, 136, 0.12);
}

.note-link-archived:hover {
  background: rgba(136, 136, 136, 0.22);
}

.note-link-archive-icon {
  display: inline;
  vertical-align: middle;
  margin-right: 2px;
}
</style>
