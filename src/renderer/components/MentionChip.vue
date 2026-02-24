<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { Trash2 } from 'lucide-vue-next'
import { entityTrashStatus, fireMentionClick } from '../stores/mentionStore'

const props = defineProps(nodeViewProps)

const id = computed(() => props.node.attrs.id as string)
const label = computed(() => props.node.attrs.label as string)
const isTrashed = computed(() => entityTrashStatus.get(id.value) === true)

function onClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement
  fireMentionClick(id.value, el.getBoundingClientRect())
}
</script>

<template>
  <NodeViewWrapper
    as="span"
    class="mention"
    :class="{ 'mention-trashed': isTrashed }"
    :data-id="id"
    @click.stop="onClick"
  >
    <Trash2 v-if="isTrashed" :size="10" class="mention-trash-icon" />@{{ label }}
  </NodeViewWrapper>
</template>

<style scoped>
.mention {
  background: rgba(91, 141, 239, 0.15);
  border-radius: 3px;
  color: var(--color-accent, #5b8def);
  font-weight: 500;
  padding: 1px 3px;
  white-space: nowrap;
  cursor: pointer;
  display: inline;
}

.mention:hover {
  background: rgba(91, 141, 239, 0.25);
}

.mention-trashed {
  color: #f06070;
  background: rgba(240, 96, 112, 0.12);
}

.mention-trashed:hover {
  background: rgba(240, 96, 112, 0.22);
}

.mention-trash-icon {
  display: inline;
  vertical-align: middle;
  margin-right: 2px;
}
</style>
