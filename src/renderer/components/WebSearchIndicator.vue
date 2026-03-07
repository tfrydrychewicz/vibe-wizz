<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  /** The search query currently in flight. Empty string = hidden. */
  query: string
}>()

/** Truncate very long queries so the indicator row stays single-line. */
const displayQuery = computed(() =>
  props.query.length > 60 ? props.query.slice(0, 57) + '…' : props.query,
)
</script>

<template>
  <div class="web-search-indicator">
    <!-- Pulsing globe SVG (Lucide-style) -->
    <svg
      class="web-search-indicator-globe"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
    <span>Searching the web for "<em>{{ displayQuery }}</em>"…</span>
  </div>
</template>
