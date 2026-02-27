<script setup lang="ts">
import { X, FileText } from 'lucide-vue-next'
import type { AttachedImage, AttachedFile } from '../composables/useFileAttachment'

const props = defineProps<{
  attachedImages: AttachedImage[]
  attachedFiles: AttachedFile[]
}>()

const emit = defineEmits<{
  'remove-image': [id: string]
  'remove-file': [id: string]
}>()

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
</script>

<template>
  <div
    v-if="attachedImages.length > 0 || attachedFiles.length > 0"
    class="attachment-bar"
  >
    <div
      v-for="img in attachedImages"
      :key="img.id"
      class="attachment-thumb"
    >
      <img :src="img.dataUrl" class="attachment-img" alt="" />
      <button class="attachment-remove" title="Remove" @click="emit('remove-image', img.id)">
        <X :size="10" />
      </button>
    </div>
    <div
      v-for="f in attachedFiles"
      :key="f.id"
      class="attachment-file"
    >
      <FileText :size="14" class="attachment-file-icon" />
      <div class="attachment-file-info">
        <span class="attachment-file-name">{{ f.name }}</span>
        <span class="attachment-file-size">{{ formatFileSize(f.size) }}</span>
      </div>
      <button class="attachment-remove attachment-remove--inline" title="Remove" @click="emit('remove-file', f.id)">
        <X :size="10" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.attachment-bar {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.attachment-thumb {
  position: relative;
  flex-shrink: 0;
  width: 64px;
  height: 64px;
  border-radius: 6px;
  overflow: visible;
}

.attachment-img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 6px;
  display: block;
  border: 1px solid var(--color-border);
}

.attachment-remove {
  position: absolute;
  top: -6px;
  right: -6px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(30, 30, 30, 0.85);
  border: 1px solid var(--color-border);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  z-index: 1;
  transition: background 0.1s;
}

.attachment-remove:hover {
  background: rgba(220, 80, 80, 0.9);
}

.attachment-file {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--color-hover);
  border: 1px solid var(--color-border);
  position: relative;
  flex-shrink: 0;
  max-width: 180px;
}

.attachment-file-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.attachment-file-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.attachment-file-name {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.attachment-file-size {
  font-size: 10.5px;
  color: var(--color-text-muted);
}

.attachment-remove--inline {
  position: static;
  width: 16px;
  height: 16px;
  border-radius: 4px;
  flex-shrink: 0;
  top: unset;
  right: unset;
}
</style>
