/**
 * In-memory chat state for the AI chat sidebar.
 * Session-scoped — messages persist while the app is open but are not saved to disk.
 */

import { ref } from 'vue'

export interface AttachedImage {
  id: string
  dataUrl: string
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'
}

export interface ExecutedAction {
  type:
    | 'created_event'
    | 'updated_event'
    | 'deleted_event'
    | 'created_action'
    | 'updated_action'
    | 'deleted_action'
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
  references?: { id: string; title: string }[]
  actions?: ExecutedAction[]
  error?: boolean
}

export const messages = ref<ChatMessage[]>([])
export const isLoading = ref(false)

export function clearMessages(): void {
  messages.value = []
}
