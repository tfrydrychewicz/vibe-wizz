/**
 * In-memory chat state for the AI chat sidebar.
 * Session-scoped — messages persist while the app is open but are not saved to disk.
 */

import { ref } from 'vue'

export type { AttachedImage, AttachedFile } from '../composables/useFileAttachment'

export interface ExecutedAction {
  type:
    | 'created_event'
    | 'updated_event'
    | 'deleted_event'
    | 'created_action'
    | 'updated_action'
    | 'deleted_action'
    | 'created_note'
  payload: {
    id: number | string
    title?: string
    start_at?: string
    end_at?: string
    status?: string
    due_date?: string | null
    assigned_entity_name?: string | null
  }
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  images?: { dataUrl: string }[]
  files?: { name: string }[]
  references?: { id: string; title: string }[]
  actions?: ExecutedAction[]
  error?: boolean
}

export const messages = ref<ChatMessage[]>([])
export const isLoading = ref(false)

export function clearMessages(): void {
  messages.value = []
}
