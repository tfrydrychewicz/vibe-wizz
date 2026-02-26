<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { Editor } from '@tiptap/vue-3'
import { CellSelection } from '@tiptap/pm/tables'

const props = defineProps<{
  editor: Editor
  x: number
  y: number
}>()
const emit = defineEmits<{ close: [] }>()

const root = ref<HTMLElement | null>(null)

// Detect if cursor is inside a merged cell (colspan or rowspan > 1)
const isInMergedCell = computed(() => {
  const { state } = props.editor
  const { $from } = state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      const attrs = node.attrs as { colspan?: number; rowspan?: number }
      return (attrs.colspan ?? 1) > 1 || (attrs.rowspan ?? 1) > 1
    }
  }
  return false
})

// Detect if multiple cells are selected (CellSelection with different anchor/head)
const hasMultiCellSelection = computed(() => {
  const { selection } = props.editor.state
  if (!(selection instanceof CellSelection)) return false
  return selection.$anchorCell.pos !== selection.$headCell.pos
})

type MenuItem = { id: string; label: string; danger?: boolean }

const menuItems = computed<(MenuItem | null)[]>(() => [
  { id: 'addColBefore', label: 'Add column before' },
  { id: 'addColAfter',  label: 'Add column after' },
  { id: 'deleteCol',    label: 'Delete column', danger: true },
  null,
  { id: 'addRowBefore', label: 'Add row before' },
  { id: 'addRowAfter',  label: 'Add row after' },
  { id: 'deleteRow',    label: 'Delete row', danger: true },
  null,
  { id: 'deleteTable',  label: 'Delete table', danger: true },
  ...(hasMultiCellSelection.value ? ([null, { id: 'mergeCells', label: 'Merge cells' }] as (MenuItem | null)[]) : []),
  ...(isInMergedCell.value        ? ([null, { id: 'splitCell',  label: 'Split cell'  }] as (MenuItem | null)[]) : []),
])

function execute(id: string): void {
  const chain = props.editor.chain().focus()
  switch (id) {
    case 'addColBefore':  chain.addColumnBefore().run(); break
    case 'addColAfter':   chain.addColumnAfter().run();  break
    case 'deleteCol':     chain.deleteColumn().run();    break
    case 'addRowBefore':  chain.addRowBefore().run();    break
    case 'addRowAfter':   chain.addRowAfter().run();     break
    case 'deleteRow':     chain.deleteRow().run();       break
    case 'deleteTable':   chain.deleteTable().run();     break
    case 'mergeCells':    chain.mergeCells().run();      break
    case 'splitCell':     chain.splitCell().run();       break
  }
  emit('close')
}

function onOutsideMousedown(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) emit('close')
}

onMounted(() => document.addEventListener('mousedown', onOutsideMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutsideMousedown))
</script>

<template>
  <div
    ref="root"
    class="table-context-menu"
    :style="{ top: y + 'px', left: x + 'px' }"
    @contextmenu.prevent
  >
    <template v-for="(item, i) in menuItems" :key="i">
      <div v-if="item === null" class="tcm-sep" />
      <button
        v-else
        class="tcm-item"
        :class="{ danger: item.danger }"
        @click="execute(item.id)"
      >
        {{ item.label }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.table-context-menu {
  position: fixed;
  z-index: 10000;
  background: var(--color-bg, #1e1e1e);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  padding: 4px 0;
  min-width: 180px;
  user-select: none;
}

.tcm-item {
  display: block;
  width: 100%;
  padding: 6px 14px;
  background: transparent;
  border: none;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.tcm-item:hover {
  background: rgba(255, 255, 255, 0.07);
}

.tcm-item.danger {
  color: #ef4444;
}

.tcm-item.danger:hover {
  background: rgba(239, 68, 68, 0.1);
}

.tcm-sep {
  height: 1px;
  background: var(--color-border);
  margin: 3px 0;
}
</style>
