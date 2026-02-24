<script setup lang="ts">
import { computed, type Component } from 'vue'
import * as icons from 'lucide-vue-next'

const props = defineProps<{
  name: string
  size?: number
  color?: string
}>()

function toPascalCase(str: string): string {
  return str
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

const iconComponent = computed<Component>(() => {
  if (!props.name) return icons.Tag as unknown as Component
  const key = toPascalCase(props.name) as keyof typeof icons
  return ((icons[key] as unknown as Component | undefined) ?? icons.Tag) as Component
})
</script>

<template>
  <component :is="iconComponent" :size="size ?? 16" :color="color" />
</template>
