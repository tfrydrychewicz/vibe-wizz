<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'

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
      <svg
        class="tb-chevron"
        :class="{ open: isOpen }"
        viewBox="0 0 10 6"
        width="8"
        height="8"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M1 1l4 4 4-4" />
      </svg>
    </button>

    <div v-if="isOpen" class="tb-dropdown-menu" @click="isOpen = false">
      <slot />
    </div>
  </div>
</template>
