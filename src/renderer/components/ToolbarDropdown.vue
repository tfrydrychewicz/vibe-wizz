<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

defineProps<{ active?: boolean }>()

const isOpen = ref(false)
const root = ref<HTMLElement | null>(null)

function toggle(): void {
  isOpen.value = !isOpen.value
}

function onOutsideMousedown(e: MouseEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) {
    isOpen.value = false
  }
}

onMounted(() => document.addEventListener('mousedown', onOutsideMousedown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onOutsideMousedown))
</script>

<template>
  <div ref="root" class="tb-dropdown">
    <button class="tb-btn tb-dropdown-btn" :class="{ active }" @click="toggle">
      <slot name="label" />
      <ChevronDown :size="10" class="tb-chevron" :class="{ open: isOpen }" />
    </button>

    <div v-if="isOpen" class="tb-dropdown-menu" @click="isOpen = false">
      <slot />
    </div>
  </div>
</template>
