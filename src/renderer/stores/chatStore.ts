/**
 * In-memory chat state for the AI chat sidebar.
 * Session-scoped — messages persist while the app is open but are not saved to disk.
 */

import { ref } from 'vue'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  references?: { id: string; title: string }[]
  error?: boolean
}

export const messages = ref<ChatMessage[]>([])
export const isLoading = ref(false)

export function clearMessages(): void {
  messages.value = []
}
