<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { X, Eye, EyeOff, BrainCircuit, CalendarDays, Bug, Plus, RefreshCw, Pencil, Trash2, AlertCircle, Loader2 } from 'lucide-vue-next'
import CalendarSourceModal from './CalendarSourceModal.vue'

const emit = defineEmits<{ close: [] }>()

// ── Category navigation ───────────────────────────────────────────────────────
type CategoryId = 'ai' | 'calendar' | 'debug'
const selectedCategory = ref<CategoryId>('ai')

const categories: { id: CategoryId; label: string; icon: typeof BrainCircuit }[] = [
  { id: 'ai', label: 'AI', icon: BrainCircuit },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'debug', label: 'Debug', icon: Bug },
]

// ── Sub-tab navigation ────────────────────────────────────────────────────────
type AiTab = 'llm' | 'transcription' | 'followup' | 'models'
type CalendarTab = 'general' | 'sync' | 'attendees'

const selectedAiTab = ref<AiTab>('llm')
const selectedCalendarTab = ref<CalendarTab>('general')

const aiTabs: { id: AiTab; label: string }[] = [
  { id: 'llm', label: 'LLM Providers' },
  { id: 'transcription', label: 'Transcription' },
  { id: 'followup', label: 'Follow-up Intelligence' },
  { id: 'models', label: 'Models' },
]

const availableModels = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const

const calendarTabs: { id: CalendarTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'sync', label: 'Sync' },
  { id: 'attendees', label: 'Attendees' },
]

// ── Calendar Sync sources ──────────────────────────────────────────────────────
interface CalendarSource {
  id: string
  provider_id: string
  name: string
  config: string
  enabled: number
  sync_interval_minutes: number
  last_sync_at: string | null
  created_at: string
}

const calendarSources = ref<CalendarSource[]>([])
const syncingSourceIds = ref(new Set<string>())
const syncErrors = ref(new Map<string, string>())
const showSourceModal = ref(false)
const editingSource = ref<CalendarSource | undefined>(undefined)
const deleteConfirmId = ref<string | null>(null)

// Push-event cleanup
const _syncUnsubs: (() => void)[] = []

function formatLastSync(lastSyncAt: string | null): string {
  if (!lastSyncAt) return 'Never synced'
  const diff = Date.now() - new Date(lastSyncAt).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 1440) return `${minutes / 60} hr`
  return '24 hr'
}

function openAddSource(): void {
  editingSource.value = undefined
  showSourceModal.value = true
}

function openEditSource(src: CalendarSource): void {
  editingSource.value = src
  showSourceModal.value = true
}

function onSourceSaved(saved: CalendarSource): void {
  showSourceModal.value = false
  const idx = calendarSources.value.findIndex((s) => s.id === saved.id)
  if (idx >= 0) {
    calendarSources.value[idx] = saved
  } else {
    calendarSources.value.push(saved)
  }
}

async function toggleSourceEnabled(src: CalendarSource): Promise<void> {
  const newEnabled = src.enabled ? 0 : 1
  await window.api.invoke('calendar-sources:update', { id: src.id, enabled: newEnabled === 1 })
  src.enabled = newEnabled
}

async function syncNow(src: CalendarSource): Promise<void> {
  if (syncingSourceIds.value.has(src.id)) return
  syncingSourceIds.value.add(src.id)
  syncErrors.value.delete(src.id)
  try {
    const result = await window.api.invoke('calendar-sources:sync-now', { id: src.id }) as { ok: boolean; count?: number; error?: string }
    if (result.ok) {
      src.last_sync_at = new Date().toISOString()
    } else {
      syncErrors.value.set(src.id, result.error ?? 'Sync failed.')
    }
  } catch (err) {
    syncErrors.value.set(src.id, err instanceof Error ? err.message : String(err))
  } finally {
    syncingSourceIds.value.delete(src.id)
  }
}

async function deleteSource(id: string): Promise<void> {
  await window.api.invoke('calendar-sources:delete', { id })
  calendarSources.value = calendarSources.value.filter((s) => s.id !== id)
  deleteConfirmId.value = null
}

// ── AI settings ───────────────────────────────────────────────────────────────
const apiKey = ref('')
const showKey = ref(false)
const anthropicKey = ref('')
const showAnthropicKey = ref(false)
const elevenLabsKey = ref('')
const showElevenLabsKey = ref(false)
const elevenLabsDiarize = ref(false)
const deepgramKey = ref('')
const showDeepgramKey = ref(false)
const transcriptionModel = ref<'elevenlabs' | 'deepgram' | 'macos'>('macos')
const transcriptionLanguage = ref('multi')
const systemAudioCapture = ref(false)

// ── Model selection settings ──────────────────────────────────────────────────
const modelChat = ref('claude-sonnet-4-6')
const modelDailyBrief = ref('claude-sonnet-4-6')
const modelBackground = ref('claude-haiku-4-5-20251001')

// ── Follow-up intelligence settings ──────────────────────────────────────────
const followupStalenessDays = ref(7)
const followupAssigneeEntityTypeId = ref('')

// ── Debug settings ────────────────────────────────────────────────────────────
const saveDebugAudio = ref(false)
const debugAudioFolder = ref('')
const reembedding = ref(false)

function openDebugAudioFolder(): void {
  window.api.invoke('debug:open-audio-folder')
}

async function reembedAll(): Promise<void> {
  if (reembedding.value) return
  reembedding.value = true
  try {
    await window.api.invoke('debug:reembed-all')
  } finally {
    reembedding.value = false
  }
}

// ── Calendar settings ─────────────────────────────────────────────────────────
const calendarSlotDuration = ref('30')
const meetingNoteTitleTemplate = ref('{date} - {title}')

// ── Attendee entity config ────────────────────────────────────────────────────
interface EntityTypeRow {
  id: string
  name: string
  icon: string
  schema: string
}

interface FieldDef {
  name: string
  type: string
}

const entityTypes = ref<EntityTypeRow[]>([])
const attendeeEntityTypeId = ref('')
const attendeeNameField = ref('')
const attendeeEmailField = ref('')

const selectedEntityFields = computed<FieldDef[]>(() => {
  if (!attendeeEntityTypeId.value) return []
  const et = entityTypes.value.find(t => t.id === attendeeEntityTypeId.value)
  if (!et) return []
  try { return (JSON.parse(et.schema) as { fields: FieldDef[] }).fields ?? [] } catch { return [] }
})

const nameFieldOptions = computed(() => [
  { value: '__name__', label: 'Entity Name (primary)' },
  ...selectedEntityFields.value
    .filter(f => f.type === 'text' || f.type === 'email')
    .map(f => ({ value: f.name, label: f.name })),
])

const emailFieldOptions = computed(() =>
  selectedEntityFields.value
    .filter(f => f.type === 'text' || f.type === 'email')
    .map(f => ({ value: f.name, label: f.name }))
)

watch(attendeeEntityTypeId, () => {
  attendeeNameField.value = ''
  attendeeEmailField.value = ''
})

// ── Load & Save ───────────────────────────────────────────────────────────────
const saving = ref(false)
const savedFeedback = ref(false)

onMounted(async () => {
  const [openai, anthropic, elevenlabs, deepgram, transcModel, transcLang, elDiarize, sysAudio, slotDuration, noteTitleTemplate, attTypeId, attNameField, attEmailField, etList, debugAudio, folder, followupDays, followupTypeId, mChat, mDailyBrief, mBackground, sources] = await Promise.all([
    window.api.invoke('settings:get', { key: 'openai_api_key' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'anthropic_api_key' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'elevenlabs_api_key' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'deepgram_api_key' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'transcription_model' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'transcription_language' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'elevenlabs_diarize' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'system_audio_capture' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'calendar_slot_duration' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'meeting_note_title_template' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_name_field' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'attendee_email_field' }) as Promise<string | null>,
    window.api.invoke('entity-types:list') as Promise<EntityTypeRow[]>,
    window.api.invoke('settings:get', { key: 'save_debug_audio' }) as Promise<string | null>,
    window.api.invoke('debug:get-audio-folder') as Promise<string>,
    window.api.invoke('settings:get', { key: 'followup_staleness_days' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'followup_assignee_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'model_chat' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'model_daily_brief' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'model_background' }) as Promise<string | null>,
    window.api.invoke('calendar-sources:list') as Promise<CalendarSource[]>,
  ])
  apiKey.value = openai ?? ''
  anthropicKey.value = anthropic ?? ''
  elevenLabsKey.value = elevenlabs ?? ''
  deepgramKey.value = deepgram ?? ''
  transcriptionModel.value = (transcModel as 'elevenlabs' | 'deepgram' | 'macos' | null) ?? 'macos'
  transcriptionLanguage.value = transcLang ?? 'multi'
  elevenLabsDiarize.value = elDiarize === 'true'
  systemAudioCapture.value = sysAudio === 'true'
  calendarSlotDuration.value = slotDuration ?? '30'
  meetingNoteTitleTemplate.value = noteTitleTemplate ?? '{date} - {title}'
  entityTypes.value = etList ?? []
  attendeeEntityTypeId.value = attTypeId ?? ''
  saveDebugAudio.value = debugAudio === 'true'
  debugAudioFolder.value = folder ?? ''
  followupStalenessDays.value = parseInt(followupDays ?? '7', 10)
  followupAssigneeEntityTypeId.value = followupTypeId ?? ''
  modelChat.value = mChat ?? 'claude-sonnet-4-6'
  modelDailyBrief.value = mDailyBrief ?? 'claude-sonnet-4-6'
  modelBackground.value = mBackground ?? 'claude-haiku-4-5-20251001'
  calendarSources.value = sources ?? []
  await nextTick()
  attendeeNameField.value = attNameField ?? ''
  attendeeEmailField.value = attEmailField ?? ''

  // Subscribe to background sync push events so the source list updates live
  _syncUnsubs.push(
    window.api.on('calendar-sync:complete', (...args: unknown[]) => {
      const { sourceId } = args[0] as { sourceId: string }
      const src = calendarSources.value.find((s) => s.id === sourceId)
      if (src) src.last_sync_at = new Date().toISOString()
      syncingSourceIds.value.delete(sourceId)
      syncErrors.value.delete(sourceId)
    })
  )
  _syncUnsubs.push(
    window.api.on('calendar-sync:error', (...args: unknown[]) => {
      const { sourceId, message } = args[0] as { sourceId: string; message: string }
      syncErrors.value.set(sourceId, message)
      syncingSourceIds.value.delete(sourceId)
    })
  )
})

onUnmounted(() => {
  for (const unsub of _syncUnsubs) unsub()
  _syncUnsubs.length = 0
})

async function save(): Promise<void> {
  saving.value = true
  await Promise.all([
    window.api.invoke('settings:set', { key: 'openai_api_key', value: apiKey.value.trim() }),
    window.api.invoke('settings:set', { key: 'anthropic_api_key', value: anthropicKey.value.trim() }),
    window.api.invoke('settings:set', { key: 'elevenlabs_api_key', value: elevenLabsKey.value.trim() }),
    window.api.invoke('settings:set', { key: 'elevenlabs_diarize', value: elevenLabsDiarize.value ? 'true' : 'false' }),
    window.api.invoke('settings:set', { key: 'system_audio_capture', value: systemAudioCapture.value ? 'true' : 'false' }),
    window.api.invoke('settings:set', { key: 'deepgram_api_key', value: deepgramKey.value.trim() }),
    window.api.invoke('settings:set', { key: 'transcription_model', value: transcriptionModel.value }),
    window.api.invoke('settings:set', { key: 'transcription_language', value: transcriptionLanguage.value }),
    window.api.invoke('settings:set', { key: 'calendar_slot_duration', value: calendarSlotDuration.value }),
    window.api.invoke('settings:set', { key: 'meeting_note_title_template', value: meetingNoteTitleTemplate.value }),
    window.api.invoke('settings:set', { key: 'attendee_entity_type_id', value: attendeeEntityTypeId.value }),
    window.api.invoke('settings:set', { key: 'attendee_name_field', value: attendeeNameField.value }),
    window.api.invoke('settings:set', { key: 'attendee_email_field', value: attendeeEmailField.value }),
    window.api.invoke('settings:set', { key: 'save_debug_audio', value: saveDebugAudio.value ? 'true' : 'false' }),
    window.api.invoke('settings:set', { key: 'followup_staleness_days', value: String(followupStalenessDays.value) }),
    window.api.invoke('settings:set', { key: 'followup_assignee_entity_type_id', value: followupAssigneeEntityTypeId.value }),
    window.api.invoke('settings:set', { key: 'model_chat', value: modelChat.value }),
    window.api.invoke('settings:set', { key: 'model_daily_brief', value: modelDailyBrief.value }),
    window.api.invoke('settings:set', { key: 'model_background', value: modelBackground.value }),
  ])
  saving.value = false
  savedFeedback.value = true
  setTimeout(() => { savedFeedback.value = false }, 2000)
}

function onBackdropKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')" @keydown="onBackdropKeydown">
    <div class="modal-panel" role="dialog" aria-labelledby="settings-title">

      <!-- Header -->
      <div class="modal-header">
        <h2 id="settings-title" class="modal-title">Settings</h2>
        <button class="modal-close" @click="emit('close')"><X :size="16" /></button>
      </div>

      <!-- Two-pane body -->
      <div class="modal-body">

        <!-- Left: category list -->
        <nav class="category-nav">
          <button
            v-for="cat in categories"
            :key="cat.id"
            class="category-item"
            :class="{ active: selectedCategory === cat.id }"
            @click="selectedCategory = cat.id"
          >
            <component :is="cat.icon" :size="15" class="cat-icon" />
            <span>{{ cat.label }}</span>
          </button>
        </nav>

        <!-- Right: settings pane -->
        <div class="settings-pane">

          <!-- ── AI ── -->
          <template v-if="selectedCategory === 'ai'">
            <div class="pane-header">
              <h3 class="pane-title">AI</h3>
              <div class="tab-bar">
                <button
                  v-for="tab in aiTabs"
                  :key="tab.id"
                  class="tab-btn"
                  :class="{ active: selectedAiTab === tab.id }"
                  @click="selectedAiTab = tab.id"
                >{{ tab.label }}</button>
              </div>
            </div>

            <!-- LLM Providers tab -->
            <template v-if="selectedAiTab === 'llm'">
              <div class="field-group">
                <label class="field-label" for="openai-key">OpenAI API Key</label>
                <p class="field-hint">
                  Used for generating semantic search embeddings (text-embedding-3-small).
                  Stored locally on your device only.
                </p>
                <div class="key-row">
                  <input
                    id="openai-key"
                    v-model="apiKey"
                    :type="showKey ? 'text' : 'password'"
                    class="modal-input key-input"
                    placeholder="sk-..."
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <button class="toggle-btn" :title="showKey ? 'Hide' : 'Show'" @click="showKey = !showKey">
                    <EyeOff v-if="showKey" :size="14" />
                    <Eye v-else :size="14" />
                  </button>
                </div>
              </div>

              <div class="field-group">
                <label class="field-label" for="anthropic-key">Anthropic API Key</label>
                <p class="field-hint">
                  Used for note summaries, NER entity detection, action item extraction, and AI chat via Claude.
                  Stored locally on your device only.
                </p>
                <div class="key-row">
                  <input
                    id="anthropic-key"
                    v-model="anthropicKey"
                    :type="showAnthropicKey ? 'text' : 'password'"
                    class="modal-input key-input"
                    placeholder="sk-ant-..."
                    autocomplete="off"
                    spellcheck="false"
                  />
                  <button class="toggle-btn" :title="showAnthropicKey ? 'Hide' : 'Show'" @click="showAnthropicKey = !showAnthropicKey">
                    <EyeOff v-if="showAnthropicKey" :size="14" />
                    <Eye v-else :size="14" />
                  </button>
                </div>
              </div>
            </template>

            <!-- Transcription tab -->
            <template v-else-if="selectedAiTab === 'transcription'">
              <div class="field-group">
                <label class="field-label">Engine</label>
                <div class="model-picker">
                  <button class="model-btn" :class="{ active: transcriptionModel === 'elevenlabs' }" @click="transcriptionModel = 'elevenlabs'">ElevenLabs</button>
                  <button class="model-btn" :class="{ active: transcriptionModel === 'deepgram' }" @click="transcriptionModel = 'deepgram'">Deepgram</button>
                  <button class="model-btn" :class="{ active: transcriptionModel === 'macos' }" @click="transcriptionModel = 'macos'">macOS</button>
                </div>
              </div>

              <!-- ElevenLabs: key + optional diarization mode -->
              <template v-if="transcriptionModel === 'elevenlabs'">
                <div class="field-group">
                  <label class="field-label" for="elevenlabs-key">ElevenLabs API Key</label>
                  <p class="field-hint">
                    Scribe v2 — 99 languages including Polish, auto-detected.
                    Stored locally on your device only.
                  </p>
                  <div class="key-row">
                    <input
                      id="elevenlabs-key"
                      v-model="elevenLabsKey"
                      :type="showElevenLabsKey ? 'text' : 'password'"
                      class="modal-input key-input"
                      placeholder="ElevenLabs API key"
                      autocomplete="off"
                      spellcheck="false"
                    />
                    <button class="toggle-btn" :title="showElevenLabsKey ? 'Hide' : 'Show'" @click="showElevenLabsKey = !showElevenLabsKey">
                      <EyeOff v-if="showElevenLabsKey" :size="14" />
                      <Eye v-else :size="14" />
                    </button>
                  </div>
                </div>
                <div class="field-group">
                  <label class="field-label">Speaker Diarization</label>
                  <label class="toggle-row">
                    <input
                      v-model="elevenLabsDiarize"
                      type="checkbox"
                      class="toggle-checkbox"
                    />
                    <span class="toggle-label">Identify speakers (Batch mode)</span>
                  </label>
                  <p class="field-hint">
                    <span v-if="elevenLabsDiarize">
                      Batch mode: audio is recorded locally, then uploaded to Scribe v2 after you stop.
                      Supports up to 48 speakers. No live transcript preview during recording.
                    </span>
                    <span v-else>
                      Realtime mode: live transcript as you speak (&lt;150ms latency). No speaker labels.
                    </span>
                  </p>
                </div>
                <div class="field-group">
                  <label class="field-label">System Audio Capture</label>
                  <label class="toggle-row">
                    <input v-model="systemAudioCapture" type="checkbox" class="toggle-checkbox" />
                    <span class="toggle-label">Capture Zoom/Meet audio (macOS 14.2+)</span>
                  </label>
                  <p class="field-hint">
                    Records both your microphone and what meeting participants say via Core Audio Taps.
                    Requires Screen &amp; System Audio Recording permission in System Settings.
                  </p>
                </div>
              </template>

              <!-- Deepgram: key + language -->
              <template v-else-if="transcriptionModel === 'deepgram'">
                <div class="field-group">
                  <label class="field-label" for="deepgram-key">Deepgram API Key</label>
                  <p class="field-hint">
                    Nova-3 streaming transcription. Stored locally on your device only.
                  </p>
                  <div class="key-row">
                    <input
                      id="deepgram-key"
                      v-model="deepgramKey"
                      :type="showDeepgramKey ? 'text' : 'password'"
                      class="modal-input key-input"
                      placeholder="Deepgram API key"
                      autocomplete="off"
                      spellcheck="false"
                    />
                    <button class="toggle-btn" :title="showDeepgramKey ? 'Hide' : 'Show'" @click="showDeepgramKey = !showDeepgramKey">
                      <EyeOff v-if="showDeepgramKey" :size="14" />
                      <Eye v-else :size="14" />
                    </button>
                  </div>
                </div>
                <div class="field-group">
                  <label class="field-label" for="transcription-lang">Language</label>
                  <p class="field-hint">
                    Auto-detect covers English and major Western languages. Set Polish explicitly for Polish speech.
                  </p>
                  <select id="transcription-lang" v-model="transcriptionLanguage" class="modal-input modal-select">
                    <option value="multi">Auto-detect (EN + ES/FR/DE/HI/RU/PT/JA/IT/NL)</option>
                    <option value="en">English</option>
                    <option value="pl">Polish</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="pt">Portuguese</option>
                    <option value="ru">Russian</option>
                    <option value="hi">Hindi</option>
                    <option value="ja">Japanese</option>
                    <option value="it">Italian</option>
                    <option value="nl">Dutch</option>
                  </select>
                </div>
                <div class="field-group">
                  <label class="field-label">System Audio Capture</label>
                  <label class="toggle-row">
                    <input v-model="systemAudioCapture" type="checkbox" class="toggle-checkbox" />
                    <span class="toggle-label">Capture Zoom/Meet audio (macOS 14.2+)</span>
                  </label>
                  <p class="field-hint">
                    Records both your microphone and what meeting participants say via Core Audio Taps.
                    Requires Screen &amp; System Audio Recording permission in System Settings.
                  </p>
                </div>
              </template>

              <!-- macOS: no key, no language (uses system locale) -->
              <template v-else>
                <div class="field-group">
                  <p class="field-hint">
                    Uses macOS on-device speech recognition (SFSpeechRecognizer). Language follows your
                    macOS system language. No API key required.
                  </p>
                </div>
              </template>
            </template>

            <!-- Follow-up Intelligence tab -->
            <template v-else-if="selectedAiTab === 'followup'">
              <div class="field-group">
                <label class="field-label" for="followup-entity-type">Assignee Entity Type</label>
                <p class="field-hint">
                  Action items assigned to entities of this type will be monitored for staleness in the Daily Brief.
                  Set to "(disabled)" to turn off follow-up tracking.
                </p>
                <select id="followup-entity-type" v-model="followupAssigneeEntityTypeId" class="modal-input modal-select">
                  <option value="">(disabled)</option>
                  <option v-for="et in entityTypes" :key="et.id" :value="et.id">{{ et.name }}</option>
                </select>
              </div>

              <div v-if="followupAssigneeEntityTypeId" class="field-group">
                <label class="field-label" for="followup-days">Staleness Threshold</label>
                <p class="field-hint">
                  Flag action items with no updates after this many days.
                </p>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <input
                    id="followup-days"
                    v-model.number="followupStalenessDays"
                    type="number"
                    min="1"
                    max="90"
                    class="modal-input"
                    style="width: 72px;"
                  />
                  <span class="field-hint" style="margin: 0;">days</span>
                </div>
              </div>
            </template>

            <!-- Models tab -->
            <template v-else-if="selectedAiTab === 'models'">
              <div class="field-group">
                <label class="field-label">Chat Model</label>
                <p class="field-hint">Model used for the Ask Wizz chat sidebar.</p>
                <div class="model-picker">
                  <button
                    v-for="m in availableModels"
                    :key="m.id"
                    class="model-btn"
                    :class="{ active: modelChat === m.id }"
                    @click="modelChat = m.id"
                  >{{ m.label }}</button>
                </div>
              </div>

              <div class="field-group">
                <label class="field-label">Daily Brief Model</label>
                <p class="field-hint">Model used to generate the Today view Daily Brief.</p>
                <div class="model-picker">
                  <button
                    v-for="m in availableModels"
                    :key="m.id"
                    class="model-btn"
                    :class="{ active: modelDailyBrief === m.id }"
                    @click="modelDailyBrief = m.id"
                  >{{ m.label }}</button>
                </div>
              </div>

              <div class="field-group">
                <label class="field-label">Background Tasks Model</label>
                <p class="field-hint">
                  Model used for NER entity detection, action item extraction, note summarization,
                  cluster theme generation, transcription post-processing, and semantic search helpers.
                </p>
                <div class="model-picker">
                  <button
                    v-for="m in availableModels"
                    :key="m.id"
                    class="model-btn"
                    :class="{ active: modelBackground === m.id }"
                    @click="modelBackground = m.id"
                  >{{ m.label }}</button>
                </div>
              </div>

              <div class="field-group">
                <label class="field-label">Embedding Model</label>
                <p class="field-hint">Used for semantic search vector embeddings. Fixed — cannot be changed.</p>
                <div class="model-picker" style="opacity: 0.5; pointer-events: none;">
                  <button class="model-btn active">text-embedding-3-small</button>
                </div>
              </div>
            </template>
          </template>

          <!-- ── Calendar ── -->
          <template v-else-if="selectedCategory === 'calendar'">
            <div class="pane-header">
              <h3 class="pane-title">Calendar</h3>
              <div class="tab-bar">
                <button
                  v-for="tab in calendarTabs"
                  :key="tab.id"
                  class="tab-btn"
                  :class="{ active: selectedCalendarTab === tab.id }"
                  @click="selectedCalendarTab = tab.id"
                >{{ tab.label }}</button>
              </div>
            </div>

            <!-- General tab -->
            <template v-if="selectedCalendarTab === 'general'">
              <div class="field-group">
                <label class="field-label">Default Slot Duration</label>
                <p class="field-hint">Duration of a new meeting when clicking or dragging a time slot.</p>
                <div class="slot-picker">
                  <button
                    v-for="opt in [{ label: '15 min', value: '15' }, { label: '30 min', value: '30' }, { label: '1 hour', value: '60' }]"
                    :key="opt.value"
                    class="slot-btn"
                    :class="{ active: calendarSlotDuration === opt.value }"
                    @click="calendarSlotDuration = opt.value"
                  >
                    {{ opt.label }}
                  </button>
                </div>
              </div>

              <div class="field-group">
                <label class="field-label">Meeting Note Title Template</label>
                <p class="field-hint">
                  Title used when creating a new meeting note. Available placeholders: <code>{date}</code>, <code>{title}</code>.
                </p>
                <input v-model="meetingNoteTitleTemplate" class="modal-input" placeholder="{date} - {title}" />
              </div>
            </template>

            <!-- Sync tab -->
            <template v-else-if="selectedCalendarTab === 'sync'">
              <div class="sync-header">
                <span class="field-label" style="text-transform:none; font-size:13px; font-weight:500; letter-spacing:0; color:var(--color-text);">Calendar Sources</span>
                <button class="add-source-btn" @click="openAddSource">
                  <Plus :size="13" />
                  <span>Add source</span>
                </button>
              </div>

              <!-- Empty state -->
              <div v-if="calendarSources.length === 0" class="sync-empty">
                <p>No calendar sources configured.</p>
                <p>Add a source to start syncing events from Google Calendar or iCal.</p>
              </div>

              <!-- Source cards -->
              <div v-else class="source-list">
                <div v-for="src in calendarSources" :key="src.id" class="source-card">
                  <div class="source-card-main">
                    <!-- Enabled toggle -->
                    <label class="source-toggle" :title="src.enabled ? 'Disable sync' : 'Enable sync'">
                      <input
                        type="checkbox"
                        :checked="src.enabled === 1"
                        class="toggle-checkbox"
                        @change="toggleSourceEnabled(src)"
                      />
                    </label>

                    <div class="source-info">
                      <div class="source-name-row">
                        <span class="source-name" :class="{ muted: !src.enabled }">{{ src.name }}</span>
                        <span class="source-provider-badge">{{ src.provider_id === 'google_apps_script' ? 'Apps Script' : src.provider_id }}</span>
                      </div>
                      <div class="source-meta">
                        <span>{{ formatLastSync(src.last_sync_at) }}</span>
                        <span class="meta-sep">·</span>
                        <span>Every {{ formatInterval(src.sync_interval_minutes) }}</span>
                        <template v-if="syncErrors.get(src.id)">
                          <span class="meta-sep">·</span>
                          <span class="source-error-badge">
                            <AlertCircle :size="11" />
                            {{ syncErrors.get(src.id) }}
                          </span>
                        </template>
                      </div>
                    </div>

                    <div class="source-actions">
                      <button
                        class="source-action-btn"
                        :disabled="syncingSourceIds.has(src.id)"
                        :title="'Sync now'"
                        @click="syncNow(src)"
                      >
                        <Loader2 v-if="syncingSourceIds.has(src.id)" :size="13" class="spin" />
                        <RefreshCw v-else :size="13" />
                      </button>
                      <button class="source-action-btn" title="Edit" @click="openEditSource(src)">
                        <Pencil :size="13" />
                      </button>
                      <button
                        class="source-action-btn danger"
                        title="Remove"
                        @click="deleteConfirmId = src.id"
                      >
                        <Trash2 :size="13" />
                      </button>
                    </div>
                  </div>

                  <!-- Delete confirmation -->
                  <div v-if="deleteConfirmId === src.id" class="delete-confirm">
                    <span>Remove this source? Synced events without linked notes will be deleted.</span>
                    <div class="delete-confirm-btns">
                      <button class="dc-cancel" @click="deleteConfirmId = null">Cancel</button>
                      <button class="dc-delete" @click="deleteSource(src.id)">Remove</button>
                    </div>
                  </div>
                </div>
              </div>
            </template>

            <!-- Attendees tab -->
            <template v-else-if="selectedCalendarTab === 'attendees'">
              <div class="field-group">
                <label class="field-label">Attendee Entity</label>
                <p class="field-hint">
                  Link meeting attendees to entities. When configured, the meeting modal lets you search and pick existing entities instead of typing name and email manually.
                </p>
                <select v-model="attendeeEntityTypeId" class="modal-input modal-select">
                  <option value="">None (free-form name + email)</option>
                  <option v-for="et in entityTypes" :key="et.id" :value="et.id">{{ et.name }}</option>
                </select>
                <template v-if="attendeeEntityTypeId">
                  <div class="attendee-field-row">
                    <div class="attendee-field-col">
                      <label class="field-label">Name Field</label>
                      <select v-model="attendeeNameField" class="modal-input modal-select">
                        <option value="">— select field —</option>
                        <option v-for="f in nameFieldOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
                      </select>
                    </div>
                    <div class="attendee-field-col">
                      <label class="field-label">Email Field</label>
                      <select v-model="attendeeEmailField" class="modal-input modal-select">
                        <option value="">— select field —</option>
                        <option v-for="f in emailFieldOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
                      </select>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </template>

          <!-- ── Debug ── -->
          <template v-else-if="selectedCategory === 'debug'">
            <div class="pane-header">
              <h3 class="pane-title">Debug</h3>
            </div>

            <div class="field-group">
              <label class="field-label">Transcription Audio</label>
              <label class="toggle-row">
                <input v-model="saveDebugAudio" type="checkbox" class="toggle-checkbox" />
                <span class="toggle-label">Save audio file after each session</span>
              </label>
              <p class="field-hint">
                When enabled, each transcription session is written to a WAV file (system audio
                or microphone paths) or WebM file (Deepgram browser capture) when the session ends.
                Useful for diagnosing transcription quality.
              </p>
              <div v-if="debugAudioFolder" class="debug-folder-row">
                <span class="debug-folder-path">{{ debugAudioFolder }}</span>
                <button class="open-folder-btn" @click="openDebugAudioFolder">Open</button>
              </div>
            </div>

            <div class="field-group">
              <label class="field-label">Embeddings</label>
              <p class="field-hint">
                Force L1 chunk embeddings, L2 note summaries, and L3 cluster generation for all
                notes. Useful after changing API keys or to recover from a corrupted embedding
                state. This may take several minutes depending on note count.
              </p>
              <button class="open-folder-btn" :disabled="reembedding" @click="reembedAll">
                {{ reembedding ? 'Re-embedding…' : 'Re-embed all notes' }}
              </button>
            </div>
          </template>

        </div>
      </div>

      <!-- Footer -->
      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="saving" @click="save">
          {{ savedFeedback ? 'Saved!' : saving ? 'Saving…' : 'Save' }}
        </button>
      </div>

    </div>
  </div>

  <!-- Calendar source add/edit modal (rendered outside the settings panel so it floats above) -->
  <CalendarSourceModal
    v-if="showSourceModal"
    :source="editingSource"
    @saved="onSourceSaved"
    @close="showSourceModal = false"
  />
</template>

<style scoped>
/* ── Backdrop & panel ──────────────────────────────────────────────────────── */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  width: 780px;
  height: 520px;
  max-width: 96vw;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
}

.modal-close {
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  transition: color 0.15s;
}

.modal-close:hover {
  color: var(--color-text);
}

/* ── Two-pane body ────────────────────────────────────────────────────────── */
.modal-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Left nav ─────────────────────────────────────────────────────────────── */
.category-nav {
  width: 168px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg) 60%, var(--color-surface));
  padding: 12px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
}

.category-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.category-item:hover {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}

.category-item.active {
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  color: var(--color-accent);
}

.cat-icon {
  flex-shrink: 0;
}

/* ── Right pane ───────────────────────────────────────────────────────────── */
.settings-pane {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 28px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

.settings-pane::-webkit-scrollbar {
  width: 6px;
}

.settings-pane::-webkit-scrollbar-track {
  background: transparent;
}

.settings-pane::-webkit-scrollbar-thumb {
  background: var(--color-border);
  border-radius: 3px;
}

.settings-pane::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* ── Pane header with tabs ────────────────────────────────────────────────── */
.pane-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
}

.pane-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.tab-bar {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--color-border);
}

.tab-btn {
  padding: 6px 14px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  white-space: nowrap;
}

.tab-btn:hover {
  color: var(--color-text);
}

.tab-btn.active {
  color: var(--color-accent);
  border-bottom-color: var(--color-accent);
}

/* ── Fields ───────────────────────────────────────────────────────────────── */
.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-text-muted);
}

.field-hint {
  font-size: 12px;
  color: var(--color-text-muted);
  margin: 0;
  line-height: 1.5;
}

.field-hint code {
  background: color-mix(in srgb, var(--color-text) 10%, transparent);
  border-radius: 3px;
  padding: 1px 4px;
  font-size: 11px;
}

.key-row {
  display: flex;
  gap: 6px;
}

.modal-input {
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 13px;
  padding: 7px 10px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s;
}

.modal-input:focus {
  border-color: var(--color-accent);
}

.key-input {
  flex: 1;
  font-family: monospace;
}

.toggle-btn {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 0 10px;
  display: flex;
  align-items: center;
  transition: color 0.15s;
}

.toggle-btn:hover {
  color: var(--color-text);
}

/* ── Checkbox toggle row ─────────────────────────────────────────────────── */
.toggle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  margin-top: 6px;
}
.toggle-checkbox {
  width: 15px;
  height: 15px;
  accent-color: var(--color-primary, #4f6ef7);
  cursor: pointer;
  flex-shrink: 0;
}
.toggle-label {
  font-size: 13px;
  color: var(--color-text);
}

/* ── Model picker (same visual style as slot picker) ─────────────────────── */
.model-picker {
  display: flex;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  overflow: hidden;
  width: fit-content;
}

.model-btn {
  padding: 6px 16px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.model-btn:last-child {
  border-right: none;
}

.model-btn:hover {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}

.model-btn.active {
  background: var(--color-accent);
  color: #fff;
  font-weight: 500;
}

/* ── Slot duration picker ─────────────────────────────────────────────────── */
.slot-picker {
  display: flex;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  overflow: hidden;
  width: fit-content;
}

.slot-btn {
  padding: 6px 18px;
  background: transparent;
  border: none;
  border-right: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}

.slot-btn:last-child {
  border-right: none;
}

.slot-btn:hover {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}

.slot-btn.active {
  background: var(--color-accent);
  color: #fff;
  font-weight: 500;
}

/* ── Attendee fields ──────────────────────────────────────────────────────── */
.modal-select {
  width: 100%;
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

.attendee-field-row {
  display: flex;
  gap: 8px;
}

.attendee-field-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* ── Debug folder row ─────────────────────────────────────────────────────── */
.debug-folder-row {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  padding: 6px 10px;
}

.debug-folder-path {
  flex: 1;
  font-size: 11px;
  font-family: monospace;
  color: var(--color-text-muted);
  word-break: break-all;
}

.open-folder-btn {
  flex-shrink: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  padding: 3px 10px;
  cursor: pointer;
  transition: background 0.12s;
}

.open-folder-btn:hover {
  background: color-mix(in srgb, var(--color-text) 10%, transparent);
}

/* ── Footer ───────────────────────────────────────────────────────────────── */
.modal-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.modal-footer :global(.btn-primary) {
  margin-top: 0;
  font-family: inherit;
}

/* ── Calendar Sync tab ────────────────────────────────────────────────────── */
.sync-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.add-source-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  background: var(--color-accent);
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.12s;
}
.add-source-btn:hover { opacity: 0.88; }

.sync-empty {
  padding: 24px 0 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.sync-empty p {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.source-card {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--color-bg);
}

.source-card-main {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
}

.source-toggle {
  display: flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}

.source-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.source-name-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.source-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.source-name.muted { color: var(--color-text-muted); }

.source-provider-badge {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
  flex-shrink: 0;
}

.source-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-text-muted);
  flex-wrap: wrap;
}

.meta-sep {
  color: var(--color-border);
}

.source-error-badge {
  display: flex;
  align-items: center;
  gap: 3px;
  color: #f87171;
  font-size: 11px;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.source-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: transparent;
  border: none;
  border-radius: 5px;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.source-action-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}
.source-action-btn.danger:hover {
  background: color-mix(in srgb, #f87171 12%, transparent);
  color: #f87171;
}
.source-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Delete confirmation inline strip ────────────────────────────────────── */
.delete-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: color-mix(in srgb, #f87171 8%, transparent);
  border-top: 1px solid color-mix(in srgb, #f87171 20%, transparent);
  font-size: 12px;
  color: var(--color-text-muted);
}

.delete-confirm-btns {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.dc-cancel {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 5px;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.dc-cancel:hover { color: var(--color-text); border-color: var(--color-text-muted); }

.dc-delete {
  padding: 4px 10px;
  background: #f87171;
  border: none;
  border-radius: 5px;
  color: #fff;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.12s;
}
.dc-delete:hover { opacity: 0.85; }

/* ── Spinner ──────────────────────────────────────────────────────────────── */
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
