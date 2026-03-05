<template>
  <div class="audio-wave-loader" :class="`size-${size}`" :style="{ '--wave-color': color }">
    <span v-for="i in barCount" :key="i" class="wave-bar" :style="{ animationDelay: `${(i - 1) * 0.12}s` }" />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  barCount?: number
  size?: 'xs' | 'sm' | 'md'
  color?: string
}>(), {
  barCount: 5,
  size: 'sm',
  color: 'currentColor',
})
</script>

<style scoped>
.audio-wave-loader {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  --wave-color: currentColor;
}

.size-xs { height: 12px; gap: 1.5px; }
.size-sm { height: 16px; gap: 2px; }
.size-md { height: 22px; gap: 3px; }

.wave-bar {
  display: block;
  width: 3px;
  height: 100%;
  background: var(--wave-color);
  border-radius: 2px;
  transform-origin: bottom center;
  animation: wave-bounce 0.9s ease-in-out infinite alternate;
}

.size-xs .wave-bar { width: 2px; }
.size-md .wave-bar { width: 4px; }

@keyframes wave-bounce {
  0%   { transform: scaleY(0.15); }
  30%  { transform: scaleY(0.7);  }
  60%  { transform: scaleY(0.35); }
  100% { transform: scaleY(1.0);  }
}
</style>
