<script setup lang="ts">
import LucideIcon from './LucideIcon.vue'
import type { EntityResult } from '../composables/useInputMention'

/**
 * Shared entity @mention picker dropdown for all textarea-based inputs
 * (ChatSidebar, AIPromptModal, etc.).
 *
 * Keyboard navigation is handled by the useInputMention composable — this
 * component is purely presentational. Uses global .input-picker CSS classes
 * from style.css so the look stays in sync with InputNoteLinkPicker.
 */
defineProps<{
  items: EntityResult[]
  activeIndex: number
}>()

const emit = defineEmits<{
  pick: [entity: EntityResult]
}>()
</script>

<template>
  <div class="input-picker">
    <button
      v-for="(entity, i) in items"
      :key="entity.id"
      class="input-picker-option"
      :class="{ 'input-picker-option--active': i === activeIndex }"
      @mousedown.prevent
      @click="emit('pick', entity)"
    >
      <span class="input-picker-icon">
        <LucideIcon :name="entity.type_icon" :size="13" />
      </span>
      <span class="input-picker-name">{{ entity.name }}</span>
      <span class="input-picker-badge">{{ entity.type_name }}</span>
    </button>
  </div>
</template>
