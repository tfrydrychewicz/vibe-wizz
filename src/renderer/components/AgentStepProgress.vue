<script setup lang="ts">
export type StepType = 'text_generation' | 'image_generation' | 'tool_call'
export type StepStatus = 'pending' | 'running' | 'complete' | 'error'

export interface StepProgress {
  stepId: number
  type: StepType
  status: StepStatus
  label: string
}

defineProps<{
  steps: StepProgress[]
  collapsed: boolean
}>()

defineEmits<{
  toggle: []
}>()

function stepTypeIcon(type: StepType): string {
  switch (type) {
    case 'text_generation': return 'T'
    case 'image_generation': return 'I'
    case 'tool_call': return 'F'
  }
}
</script>

<template>
  <div class="agent-progress">
    <button class="agent-progress-toggle" @click="$emit('toggle')">
      <svg class="agent-progress-chevron" :class="{ 'is-collapsed': collapsed }" width="12" height="12" viewBox="0 0 12 12">
        <path d="M3 4.5L6 7.5L9 4.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="agent-progress-title">Agent steps</span>
      <span class="agent-progress-count">{{ steps.filter(s => s.status === 'complete').length }}/{{ steps.length }}</span>
    </button>

    <Transition name="agent-collapse">
      <div v-if="!collapsed" class="agent-progress-list">
        <div
          v-for="step in steps"
          :key="step.stepId"
          class="agent-step"
          :class="`agent-step--${step.status}`"
        >
          <!-- Status indicator -->
          <div class="agent-step-icon">
            <!-- Pending: hollow circle -->
            <svg v-if="step.status === 'pending'" width="16" height="16" viewBox="0 0 16 16" class="agent-icon-pending">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/>
            </svg>

            <!-- Running: animated spinner ring -->
            <svg v-else-if="step.status === 'running'" width="16" height="16" viewBox="0 0 16 16" class="agent-icon-running">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2"/>
              <path
                d="M8 2 A6 6 0 0 1 14 8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>

            <!-- Complete: animated checkmark -->
            <svg v-else-if="step.status === 'complete'" width="16" height="16" viewBox="0 0 16 16" class="agent-icon-complete">
              <circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.15"/>
              <path
                class="agent-check-path"
                d="M5 8.2L7.2 10.4L11 5.6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>

            <!-- Error: X mark -->
            <svg v-else width="16" height="16" viewBox="0 0 16 16" class="agent-icon-error">
              <circle cx="8" cy="8" r="6" fill="currentColor" opacity="0.12"/>
              <path d="M5.75 5.75L10.25 10.25M10.25 5.75L5.75 10.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>

          <!-- Step type badge + label -->
          <span class="agent-step-type">{{ stepTypeIcon(step.type) }}</span>
          <span class="agent-step-label">{{ step.label }}</span>
        </div>
      </div>
    </Transition>
  </div>
</template>
