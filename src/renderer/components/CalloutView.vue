<script setup lang="ts">
import { computed } from 'vue'
import { NodeViewWrapper, NodeViewContent, nodeViewProps } from '@tiptap/vue-3'
import { Info, AlertTriangle, CheckCircle2, XCircle, Lightbulb } from 'lucide-vue-next'
import type { CalloutType } from '../extensions/Callout'

const props = defineProps(nodeViewProps)

const CALLOUT_TYPES: Array<{
  value: CalloutType
  label: string
  color: string
  bg: string
  icon: unknown
}> = [
  { value: 'info',    label: 'Note',    color: 'var(--color-accent)',   bg: 'rgba(91,141,239,0.08)',  icon: Info },
  { value: 'warning', label: 'Warning', color: 'var(--color-warning)',  bg: 'rgba(245,158,11,0.08)', icon: AlertTriangle },
  { value: 'success', label: 'Success', color: 'var(--color-success)',  bg: 'rgba(52,211,153,0.08)', icon: CheckCircle2 },
  { value: 'danger',  label: 'Danger',  color: 'var(--color-danger)',   bg: 'rgba(239,68,68,0.08)',  icon: XCircle },
  { value: 'tip',     label: 'Tip',     color: 'var(--color-note)',     bg: 'rgba(80,192,160,0.08)', icon: Lightbulb },
]

const calloutType = computed(() => (props.node.attrs.calloutType as CalloutType) ?? 'info')
const currentDef = computed(() => CALLOUT_TYPES.find(t => t.value === calloutType.value) ?? CALLOUT_TYPES[0])

function setType(type: CalloutType): void {
  props.updateAttributes({ calloutType: type })
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="callout-wrapper"
    :style="{ '--callout-color': currentDef.color, background: currentDef.bg }"
  >
    <!-- Header: icon + label + type picker -->
    <div class="callout-header" contenteditable="false">
      <component :is="currentDef.icon" class="callout-icon" :size="14" />
      <span class="callout-label">{{ currentDef.label }}</span>

      <div class="callout-type-picker">
        <button
          v-for="t in CALLOUT_TYPES"
          :key="t.value"
          class="callout-type-dot"
          :class="{ active: t.value === calloutType }"
          :style="{ '--dot-color': t.color }"
          :title="t.label"
          @click="setType(t.value)"
        />
      </div>
    </div>

    <!-- Editable content -->
    <NodeViewContent as="div" class="callout-content" />
  </NodeViewWrapper>
</template>

<style scoped>
.callout-wrapper {
  border-left: 3px solid var(--callout-color);
  border-radius: 0 6px 6px 0;
  margin: 8px 0;
  overflow: hidden;
}

.callout-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px 4px;
}

.callout-icon {
  color: var(--callout-color);
  flex-shrink: 0;
}

.callout-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--callout-color);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex: 1;
}

/* Type picker — only visible on hover */
.callout-type-picker {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.15s;
}

.callout-wrapper:hover .callout-type-picker {
  opacity: 1;
}

.callout-type-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--dot-color);
  border: 1.5px solid transparent;
  opacity: 0.45;
  cursor: pointer;
  padding: 0;
  transition: opacity 0.12s, border-color 0.12s, transform 0.1s;
  flex-shrink: 0;
}

.callout-type-dot:hover {
  opacity: 0.85;
  transform: scale(1.2);
}

.callout-type-dot.active {
  opacity: 1;
  border-color: rgba(255, 255, 255, 0.5);
}

.callout-content {
  padding: 4px 16px 12px;
  font-size: 14px;
  line-height: 1.6;
}

/* Remove top margin from the first paragraph inside callout */
.callout-content :deep(> p:first-child) {
  margin-top: 0;
}

.callout-content :deep(> p:last-child) {
  margin-bottom: 0;
}
</style>
