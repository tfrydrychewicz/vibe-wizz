/**
 * In-memory chat state for the AI chat sidebar.
 * Session-scoped — messages persist while the app is open but are not saved to disk.
 */

import { ref } from 'vue'

export type { AttachedImage, AttachedFile } from '../composables/useFileAttachment'
export type { NoteSelectionAttachment } from '../types/noteSelection'

export interface ExecutedAction {
  type:
    | 'created_event'
    | 'updated_event'
    | 'deleted_event'
    | 'created_action'
    | 'updated_action'
    | 'deleted_action'
    | 'created_note'
    | 'created_entity'
    | 'ensured_action_created'   // ensure_action_item_for_task — new row inserted
    | 'ensured_action_found'     // ensure_action_item_for_task — existing row found
  payload: {
    id: number | string
    /** Present on ensured_action_* actions; echoed to Claude as action_item_id */
    action_item_id?: string
    title?: string
    name?: string
    type_name?: string
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
  /** Note selection attachments pasted from the editor; stored for history display */
  noteSelections?: import('../types/noteSelection').NoteSelectionAttachment[]
  references?: { id: string; title: string }[]
  entityRefs?: { id: string; name: string }[]
  actions?: ExecutedAction[]
  error?: boolean
  warning?: string
}

export const messages = ref<ChatMessage[]>([])
export const isLoading = ref(false)
export const selectedModelId = ref<string>('')

export function clearMessages(): void {
  messages.value = []
}
