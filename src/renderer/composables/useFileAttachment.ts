import { ref } from 'vue'

export interface AttachedImage {
  id: string
  dataUrl: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

export interface AttachedFile {
  id: string
  name: string
  content: string                              // plain text, or base64 (no data: prefix) for PDFs
  mimeType: 'application/pdf' | 'text/plain'  // normalised for Anthropic API
  size: number
}

export const SUPPORTED_ALL_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,.pdf,.txt,.csv,.md'
export const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

const IMAGE_MIME_TYPES: AttachedImage['mimeType'][] = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]

/**
 * Reusable composable for image + document file attachment in any input area.
 * Handles image thumbnails (JPEG/PNG/GIF/WebP) and document files (PDF/TXT/CSV/MD).
 *
 * Usage:
 *   const { attachedImages, attachedFiles, isDragOver, dropError,
 *           removeImage, removeFile, onPaste, onDrop, onFileInputChange,
 *           formatFileSize } = useFileAttachment()
 */
export function useFileAttachment() {
  const attachedImages = ref<AttachedImage[]>([])
  const attachedFiles = ref<AttachedFile[]>([])
  const isDragOver = ref(false)
  const dropError = ref('')
  let dropErrorTimer: ReturnType<typeof setTimeout> | null = null

  function showError(msg: string): void {
    dropError.value = msg
    if (dropErrorTimer) clearTimeout(dropErrorTimer)
    dropErrorTimer = setTimeout(() => { dropError.value = '' }, 2500)
  }

  function processImageFile(file: File): void {
    const mime = file.type as AttachedImage['mimeType']
    if (!IMAGE_MIME_TYPES.includes(mime)) {
      showError(`"${file.name}" is not a supported image type (JPEG, PNG, GIF, WebP)`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      attachedImages.value.push({
        id: crypto.randomUUID(),
        dataUrl: reader.result as string,
        mimeType: mime,
      })
    }
    reader.readAsDataURL(file)
  }

  function processDocumentFile(file: File): void {
    if (file.size > MAX_FILE_SIZE) {
      showError(`"${file.name}" is too large (max 10 MB)`)
      return
    }
    const isPdf = file.type === 'application/pdf'
    const isText =
      file.type.startsWith('text/') || file.name.endsWith('.md') || file.name.endsWith('.csv')
    if (!isPdf && !isText) {
      showError(`"${file.name}" is not a supported type (PDF, TXT, CSV, MD, or image)`)
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const apiMime: AttachedFile['mimeType'] = isPdf ? 'application/pdf' : 'text/plain'
      let content: string
      if (isPdf) {
        // FileReader.readAsDataURL gives "data:application/pdf;base64,<data>" — strip prefix
        const dataUrl = reader.result as string
        content = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
      } else {
        content = reader.result as string
      }
      attachedFiles.value.push({
        id: crypto.randomUUID(),
        name: file.name,
        content,
        mimeType: apiMime,
        size: file.size,
      })
    }
    if (isPdf) reader.readAsDataURL(file)
    else reader.readAsText(file)
  }

  function processAnyFile(file: File): void {
    if (file.type.startsWith('image/')) {
      processImageFile(file)
    } else {
      processDocumentFile(file)
    }
  }

  function removeImage(id: string): void {
    const idx = attachedImages.value.findIndex((img) => img.id === id)
    if (idx !== -1) attachedImages.value.splice(idx, 1)
  }

  function removeFile(id: string): void {
    const idx = attachedFiles.value.findIndex((f) => f.id === id)
    if (idx !== -1) attachedFiles.value.splice(idx, 1)
  }

  function onPaste(e: ClipboardEvent): void {
    for (const item of e.clipboardData?.items ?? []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        e.preventDefault()
        const file = item.getAsFile()
        if (file) processImageFile(file)
      }
    }
  }

  function onDrop(e: DragEvent): void {
    isDragOver.value = false
    for (const file of e.dataTransfer?.files ?? []) {
      processAnyFile(file)
    }
  }

  function onFileInputChange(e: Event): void {
    for (const file of (e.target as HTMLInputElement).files ?? []) {
      processAnyFile(file)
    }
    ;(e.target as HTMLInputElement).value = ''
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return {
    attachedImages,
    attachedFiles,
    isDragOver,
    dropError,
    removeImage,
    removeFile,
    onPaste,
    onDrop,
    onFileInputChange,
    formatFileSize,
  }
}
