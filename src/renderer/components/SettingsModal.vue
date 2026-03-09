<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import { X, Eye, EyeOff, BrainCircuit, CalendarDays, CheckSquare, Bug, Plus, RefreshCw, Pencil, Trash2, AlertCircle, Loader2, Globe } from 'lucide-vue-next'
import CalendarSourceModal from './CalendarSourceModal.vue'
import AIProviderCard from './AIProviderCard.vue'
import FeatureChainEditor from './FeatureChainEditor.vue'
import GTDSettingsPanel from './GTDSettingsPanel.vue'
import RichTextInput from './RichTextInput.vue'
import type { RichInputContent } from './RichTextInput.vue'

const providerCardRefs = new Map<string, InstanceType<typeof AIProviderCard>>()

const emit = defineEmits<{ close: [] }>()

// ── Navigation ────────────────────────────────────────────────────────────────
type NavSection =
  | 'ai:llm' | 'ai:personalization' | 'ai:models' | 'ai:transcription' | 'ai:followup'
  | 'actions'
  | 'calendar:general' | 'calendar:sync' | 'calendar:attendees'
  | 'debug'

const activeSection = ref<NavSection>('ai:llm')




// ── AI Providers ──────────────────────────────────────────────────────────────
interface ProviderModel {
  id: string
  label: string
  capabilities: string[]
  enabled: boolean
}

interface ProviderRow {
  id: string
  label: string
  apiKey: string
  enabled: boolean
  models: ProviderModel[]
}

interface FeatureChainModel {
  position: number
  modelId: string
  modelLabel: string
  providerId: string
  providerLabel: string
  enabled: boolean
}

interface FeatureChain {
  featureSlot: string
  label: string
  description: string
  capability: string
  models: FeatureChainModel[]
}

const PROVIDER_OPTIONS = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'gemini', label: 'Google Gemini' },
]

const providers = ref<ProviderRow[]>([])
const featureChains = ref<FeatureChain[]>([])
const showAddProvider = ref(false)

const allEnabledModels = computed(() =>
  providers.value.flatMap((p) =>
    p.models
      .filter((m) => m.enabled)
      .map((m) => ({
        id: m.id,
        label: m.label,
        providerId: p.id,
        providerLabel: p.label,
        capability: m.capabilities.includes('embedding') ? 'embedding' as const : m.capabilities.includes('image') ? 'image' as const : 'chat' as const,
      })),
  ),
)

function addProvider(id: string): void {
  if (providers.value.some((p) => p.id === id)) return
  const opt = PROVIDER_OPTIONS.find((o) => o.id === id)!
  providers.value.push({ id, label: opt.label, apiKey: '', enabled: true, models: [] })
  showAddProvider.value = false
}

async function onProviderDeleted(id: string): Promise<void> {
  providers.value = providers.value.filter((p) => p.id !== id)
  featureChains.value = await window.api.invoke('ai-feature-models:list') as FeatureChain[]
}

async function onChainChange({ featureSlot, modelIds }: { featureSlot: string; modelIds: string[] }): Promise<void> {
  await window.api.invoke('ai-feature-models:save', { featureSlot, modelIds })
}

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
const elevenLabsKey = ref('')
const showElevenLabsKey = ref(false)
const elevenLabsDiarize = ref(false)
const webSearchEnabled = ref(false)
const deepgramKey = ref('')
const showDeepgramKey = ref(false)
const transcriptionModel = ref<'elevenlabs' | 'deepgram' | 'macos'>('macos')
const transcriptionLanguage = ref('multi')
const systemAudioCapture = ref(false)

// ── Follow-up intelligence settings ──────────────────────────────────────────
const followupStalenessDays = ref(7)
const followupAssigneeEntityTypeId = ref('')

// ── Personalization ───────────────────────────────────────────────────────────
const personalizationInputRef = ref<InstanceType<typeof RichTextInput> | null>(null)
const _personalizationHtml = ref('')   // cached HTML restored once the section mounts

// Restore editor content when the personalization section is navigated to
watch(activeSection, async (section) => {
  if (section === 'ai:personalization' && _personalizationHtml.value) {
    await nextTick()
    personalizationInputRef.value?.setContent(_personalizationHtml.value)
  }
})

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
const teamEntityTypeId = ref('')
const teamNameField = ref('')
const teamEmailField = ref('')
const teamMembersField = ref('')

function entityFieldsFor(typeId: string): FieldDef[] {
  if (!typeId) return []
  const et = entityTypes.value.find(t => t.id === typeId)
  if (!et) return []
  try { return (JSON.parse(et.schema) as { fields: FieldDef[] }).fields ?? [] } catch { return [] }
}

const selectedEntityFields = computed<FieldDef[]>(() => entityFieldsFor(attendeeEntityTypeId.value))
const selectedTeamEntityFields = computed<FieldDef[]>(() => entityFieldsFor(teamEntityTypeId.value))

function nameOptionsFor(fields: FieldDef[]) {
  return [
    { value: '__name__', label: 'Entity Name (primary)' },
    ...fields.filter(f => f.type === 'text' || f.type === 'email').map(f => ({ value: f.name, label: f.name })),
  ]
}

function emailOptionsFor(fields: FieldDef[]) {
  return fields.filter(f => f.type === 'text' || f.type === 'email').map(f => ({ value: f.name, label: f.name }))
}

const nameFieldOptions = computed(() => nameOptionsFor(selectedEntityFields.value))
const emailFieldOptions = computed(() => emailOptionsFor(selectedEntityFields.value))
const teamNameFieldOptions = computed(() => nameOptionsFor(selectedTeamEntityFields.value))
const teamEmailFieldOptions = computed(() => emailOptionsFor(selectedTeamEntityFields.value))
const teamMembersFieldOptions = computed<FieldDef[]>(() => selectedTeamEntityFields.value)

watch(attendeeEntityTypeId, () => {
  attendeeNameField.value = ''
  attendeeEmailField.value = ''
})

watch(teamEntityTypeId, () => {
  teamNameField.value = ''
  teamEmailField.value = ''
  teamMembersField.value = ''
})

// ── Load & Save ───────────────────────────────────────────────────────────────
const saving = ref(false)
const savedFeedback = ref(false)

onMounted(async () => {
  const [elevenlabs, deepgram, transcModel, transcLang, elDiarize, sysAudio, slotDuration, noteTitleTemplate, attTypeId, attNameField, attEmailField, teamTypeId, teamNameFieldVal, teamEmailFieldVal, teamMembersFieldVal, etList, debugAudio, folder, followupDays, followupTypeId, sources, providersRes, chainsRes, webSearch, personalizationHtml] = await Promise.all([
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
    window.api.invoke('settings:get', { key: 'team_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'team_name_field' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'team_email_field' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'team_members_field' }) as Promise<string | null>,
    window.api.invoke('entity-types:list') as Promise<EntityTypeRow[]>,
    window.api.invoke('settings:get', { key: 'save_debug_audio' }) as Promise<string | null>,
    window.api.invoke('debug:get-audio-folder') as Promise<string>,
    window.api.invoke('settings:get', { key: 'followup_staleness_days' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'followup_assignee_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('calendar-sources:list') as Promise<CalendarSource[]>,
    window.api.invoke('ai-providers:list') as Promise<ProviderRow[]>,
    window.api.invoke('ai-feature-models:list') as Promise<FeatureChain[]>,
    window.api.invoke('settings:get', { key: 'web_search_enabled' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'ai_personalization_html' }) as Promise<string | null>,
  ])
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
  teamEntityTypeId.value = teamTypeId ?? ''
  saveDebugAudio.value = debugAudio === 'true'
  debugAudioFolder.value = folder ?? ''
  followupStalenessDays.value = parseInt(followupDays ?? '7', 10)
  followupAssigneeEntityTypeId.value = followupTypeId ?? ''
  calendarSources.value = sources ?? []
  providers.value = providersRes ?? []
  featureChains.value = chainsRes ?? []
  webSearchEnabled.value = webSearch === 'true'
  await nextTick()
  attendeeNameField.value = attNameField ?? ''
  attendeeEmailField.value = attEmailField ?? ''
  teamNameField.value = teamNameFieldVal ?? ''
  teamEmailField.value = teamEmailFieldVal ?? ''
  teamMembersField.value = teamMembersFieldVal ?? ''
  if (personalizationHtml) {
    _personalizationHtml.value = personalizationHtml
    if (activeSection.value === 'ai:personalization' && personalizationInputRef.value) {
      personalizationInputRef.value.setContent(personalizationHtml)
    }
  }

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

  // Save all provider cards
  await Promise.all(
    providers.value.map(async (p) => {
      const card = providerCardRefs.get(p.id)
      if (!card) return
      const data = card.getData()
      await window.api.invoke('ai-providers:save', { id: p.id, ...data })
    })
  )
  providers.value = await window.api.invoke('ai-providers:list') as ProviderRow[]
  featureChains.value = await window.api.invoke('ai-feature-models:list') as FeatureChain[]

  await Promise.all([
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
    window.api.invoke('settings:set', { key: 'team_entity_type_id', value: teamEntityTypeId.value }),
    window.api.invoke('settings:set', { key: 'team_name_field', value: teamNameField.value }),
    window.api.invoke('settings:set', { key: 'team_email_field', value: teamEmailField.value }),
    window.api.invoke('settings:set', { key: 'team_members_field', value: teamMembersField.value }),
    window.api.invoke('settings:set', { key: 'save_debug_audio', value: saveDebugAudio.value ? 'true' : 'false' }),
    window.api.invoke('settings:set', { key: 'followup_staleness_days', value: String(followupStalenessDays.value) }),
    window.api.invoke('settings:set', { key: 'followup_assignee_entity_type_id', value: followupAssigneeEntityTypeId.value }),
    window.api.invoke('settings:set', { key: 'web_search_enabled', value: webSearchEnabled.value ? 'true' : 'false' }),
    ...(personalizationInputRef.value ? (() => {
      const content: RichInputContent = personalizationInputRef.value!.getContent()
      const html: string = personalizationInputRef.value!.getHtml()
      return [
        window.api.invoke('settings:set', { key: 'ai_personalization_html', value: html }),
        window.api.invoke('settings:set', { key: 'ai_personalization_text', value: content.text }),
        window.api.invoke('settings:set', { key: 'ai_personalization_entity_ids', value: JSON.stringify(content.mentionedEntityIds) }),
        window.api.invoke('settings:set', { key: 'ai_personalization_note_ids', value: JSON.stringify(content.mentionedNoteIds) }),
      ]
    })() : []),
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

        <!-- Left: tree nav -->
        <nav class="category-nav">
          <!-- AI -->
          <div class="nav-group-label">
            <BrainCircuit :size="14" class="cat-icon" />
            <span>AI</span>
          </div>
          <button class="nav-subitem" :class="{ active: activeSection === 'ai:llm' }" @click="activeSection = 'ai:llm'">LLM Providers</button>
          <button class="nav-subitem" :class="{ active: activeSection === 'ai:personalization' }" @click="activeSection = 'ai:personalization'">Personalization</button>
          <button class="nav-subitem" :class="{ active: activeSection === 'ai:models' }" @click="activeSection = 'ai:models'">AI Features</button>
          <button class="nav-subitem" :class="{ active: activeSection === 'ai:transcription' }" @click="activeSection = 'ai:transcription'">Transcription</button>
          <button class="nav-subitem" :class="{ active: activeSection === 'ai:followup' }" @click="activeSection = 'ai:followup'">Follow-up</button>

          <!-- Actions -->
          <button class="category-item" :class="{ active: activeSection === 'actions' }" @click="activeSection = 'actions'">
            <CheckSquare :size="14" class="cat-icon" />
            <span>Actions</span>
          </button>

          <!-- Calendar -->
          <div class="nav-group-label">
            <CalendarDays :size="14" class="cat-icon" />
            <span>Calendar</span>
          </div>
          <button class="nav-subitem" :class="{ active: activeSection === 'calendar:general' }" @click="activeSection = 'calendar:general'">General</button>
          <button class="nav-subitem" :class="{ active: activeSection === 'calendar:sync' }" @click="activeSection = 'calendar:sync'">Calendar Sync</button>
          <button class="nav-subitem" :class="{ active: activeSection === 'calendar:attendees' }" @click="activeSection = 'calendar:attendees'">Attendees</button>

          <!-- Debug -->
          <button class="category-item" :class="{ active: activeSection === 'debug' }" @click="activeSection = 'debug'">
            <Bug :size="14" class="cat-icon" />
            <span>Debug</span>
          </button>
        </nav>

        <!-- Right: settings pane -->
        <div class="settings-pane">

          <!-- ── AI: LLM Providers ── -->
          <template v-if="activeSection === 'ai:llm'">
            <div class="pane-header"><h3 class="pane-title">LLM Providers</h3></div>

            <div class="field-group web-search-setting">
              <label class="field-label">
                <Globe :size="13" style="margin-right: 5px; vertical-align: middle;" />
                Web Search
              </label>
              <label class="toggle-row">
                <input v-model="webSearchEnabled" type="checkbox" class="toggle-checkbox" />
                <span class="toggle-label">Enable local web search for AI chat</span>
              </label>
              <p class="field-hint">
                <span v-if="webSearchEnabled" class="web-search-enabled-hint">
                  The AI assistant can search DuckDuckGo and read web pages to answer questions about current events, documentation, or anything not in your notes. No API key required — searches run locally on your device.
                </span>
                <span v-else>
                  When enabled, the AI can use DuckDuckGo to find up-to-date information. All searches run locally — no external API key needed.
                </span>
              </p>
            </div>

            <AIProviderCard
              v-for="p in providers"
              :key="p.id"
              :ref="(el) => { if (el) providerCardRefs.set(p.id, el as InstanceType<typeof AIProviderCard>) }"
              :providerId="p.id"
              :providerLabel="p.label"
              :apiKey="p.apiKey"
              :models="p.models"
              @deleted="onProviderDeleted(p.id)"
            />

            <div v-if="providers.length === 0 && !showAddProvider" class="providers-empty">
              <p>No AI providers configured.</p>
              <p>Add Anthropic, OpenAI, or Google Gemini to enable AI features.</p>
            </div>

            <template v-if="showAddProvider">
              <div class="add-provider-picker">
                <span class="field-label" style="margin-bottom: 8px; display: block;">Choose a provider</span>
                <div class="provider-option-chips">
                  <button
                    v-for="opt in PROVIDER_OPTIONS.filter(o => !providers.some(p => p.id === o.id))"
                    :key="opt.id"
                    class="provider-chip"
                    @click="addProvider(opt.id)"
                  >{{ opt.label }}</button>
                  <span
                    v-if="PROVIDER_OPTIONS.every(o => providers.some(p => p.id === o.id))"
                    class="field-hint"
                  >All providers added.</span>
                </div>
                <button class="cancel-add-provider-btn" @click="showAddProvider = false">Cancel</button>
              </div>
            </template>
            <button v-else class="add-provider-btn" @click="showAddProvider = true">
              <Plus :size="13" />
              Add Provider
            </button>
          </template>

          <!-- ── AI: Personalization ── -->
          <template v-else-if="activeSection === 'ai:personalization'">
            <div class="pane-header"><h3 class="pane-title">Personalization</h3></div>

            <div class="field-group personalization-group">
              <p class="field-hint">
                This is prepended to every AI prompt so Wizz always knows who it is talking to.
                Use <code>@</code> to mention entities and <code>[[</code> to include specific notes as context.
              </p>
              <RichTextInput
                  ref="personalizationInputRef"
                  placeholder="Describe yourself, your role, your team, and your preferences…"
                  class="personalization-input"
                />
                <p class="field-hint" style="margin-top: 4px;">
                  Applies to all AI features — chat, daily briefs, entity reviews, and more.
                </p>
            </div>
          </template>

          <!-- ── AI: AI Features ── -->
          <template v-else-if="activeSection === 'ai:models'">
            <div class="pane-header"><h3 class="pane-title">AI Features</h3></div>

            <div v-if="allEnabledModels.length === 0" class="chains-empty">
              <p>
                Configure providers in the <strong>LLM Providers</strong> section first,
                then return here to assign models to each AI feature.
              </p>
            </div>
            <div v-else class="feature-chains">
              <FeatureChainEditor
                v-for="chain in featureChains"
                :key="chain.featureSlot"
                :featureSlot="chain.featureSlot"
                :label="chain.label"
                :description="chain.description"
                :capability="(chain.capability as 'chat' | 'embedding' | 'image')"
                :modelIds="chain.models.map(m => m.modelId)"
                :availableModels="allEnabledModels"
                @change="onChainChange"
              />
            </div>
          </template>

          <!-- ── AI: Transcription ── -->
          <template v-else-if="activeSection === 'ai:transcription'">
            <div class="pane-header"><h3 class="pane-title">Transcription</h3></div>

            <div class="field-group">
              <label class="field-label">Engine</label>
              <div class="model-picker">
                <button class="model-btn" :class="{ active: transcriptionModel === 'elevenlabs' }" @click="transcriptionModel = 'elevenlabs'">ElevenLabs</button>
                <button class="model-btn" :class="{ active: transcriptionModel === 'deepgram' }" @click="transcriptionModel = 'deepgram'">Deepgram</button>
                <button class="model-btn" :class="{ active: transcriptionModel === 'macos' }" @click="transcriptionModel = 'macos'">macOS</button>
              </div>
            </div>

            <!-- ElevenLabs -->
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
                  <input v-model="elevenLabsDiarize" type="checkbox" class="toggle-checkbox" />
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

            <!-- Deepgram -->
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

            <!-- macOS -->
            <template v-else>
              <div class="field-group">
                <p class="field-hint">
                  Uses macOS on-device speech recognition (SFSpeechRecognizer). Language follows your
                  macOS system language. No API key required.
                </p>
              </div>
            </template>
          </template>

          <!-- ── AI: Follow-up Intelligence ── -->
          <template v-else-if="activeSection === 'ai:followup'">
            <div class="pane-header"><h3 class="pane-title">Follow-up Intelligence</h3></div>

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
          </template>

          <!-- ── Actions ── -->
          <template v-else-if="activeSection === 'actions'">
            <div class="pane-header"><h3 class="pane-title">Actions</h3></div>
            <GTDSettingsPanel />
          </template>

          <!-- ── Calendar: General ── -->
          <template v-else-if="activeSection === 'calendar:general'">
            <div class="pane-header"><h3 class="pane-title">General</h3></div>

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

          <!-- ── Calendar: Sync ── -->
          <template v-else-if="activeSection === 'calendar:sync'">
            <div class="pane-header"><h3 class="pane-title">Calendar Sync</h3></div>

            <div class="sync-header">
              <button class="add-source-btn" @click="openAddSource">
                <Plus :size="13" />
                <span>Add source</span>
              </button>
            </div>

            <div v-if="calendarSources.length === 0" class="sync-empty">
              <p>No calendar sources configured.</p>
              <p>Add a source to start syncing events from Google Calendar or iCal.</p>
            </div>

            <div v-else class="source-list">
              <div v-for="src in calendarSources" :key="src.id" class="source-card">
                <div class="source-card-main">
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

          <!-- ── Calendar: Attendees ── -->
          <template v-else-if="activeSection === 'calendar:attendees'">
            <div class="pane-header"><h3 class="pane-title">Attendees</h3></div>

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

            <div class="field-group">
              <label class="field-label">Team Entity</label>
              <p class="field-hint">
                Optionally also link meeting attendees to team entities (e.g. a team distribution email). Matched teams appear alongside individual attendees in meeting popups and can be searched when adding attendees.
              </p>
              <select v-model="teamEntityTypeId" class="modal-input modal-select">
                <option value="">None</option>
                <option v-for="et in entityTypes" :key="et.id" :value="et.id">{{ et.name }}</option>
              </select>
              <template v-if="teamEntityTypeId">
                <div class="attendee-field-row">
                  <div class="attendee-field-col">
                    <label class="field-label">Name Field</label>
                    <select v-model="teamNameField" class="modal-input modal-select">
                      <option value="">— select field —</option>
                      <option v-for="f in teamNameFieldOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
                    </select>
                  </div>
                  <div class="attendee-field-col">
                    <label class="field-label">Email Field</label>
                    <select v-model="teamEmailField" class="modal-input modal-select">
                      <option value="">— select field —</option>
                      <option v-for="f in teamEmailFieldOptions" :key="f.value" :value="f.value">{{ f.label }}</option>
                    </select>
                  </div>
                </div>
                <label class="field-label" style="margin-top: 8px;">Members Field</label>
                <select v-model="teamMembersField" class="modal-input modal-select">
                  <option value="">None (don't expand team members)</option>
                  <option v-for="f in teamMembersFieldOptions" :key="f.name" :value="f.name">{{ f.name }}</option>
                </select>
                <p class="field-hint">
                  When a team appears as a meeting attendee, this field's members are used for speaker identification in transcription. Supports computed fields (WQL query results), entity reference lists (resolved to person names), text lists (one name per line), or comma-separated text.
                </p>
              </template>
            </div>
          </template>

          <!-- ── Debug ── -->
          <template v-else-if="activeSection === 'debug'">
            <div class="pane-header"><h3 class="pane-title">Debug</h3></div>

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
  width: 176px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg) 60%, var(--color-surface));
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}

/* Category-level items (Actions, Debug) */
.category-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background 0.12s, color 0.12s;
  margin-top: 2px;
}

.category-item:hover {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.category-item.active {
  background: color-mix(in srgb, var(--color-accent) 18%, transparent);
  color: var(--color-accent);
}

/* Group label (AI, Calendar) — non-clickable header */
.nav-group-label {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 4px;
  color: var(--color-text);
  font-size: 13px;
  font-weight: 600;
  margin-top: 2px;
  user-select: none;
}

/* Subcategory nav items — indented */
.nav-subitem {
  display: block;
  width: 100%;
  padding: 5px 10px 5px 30px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12.5px;
  font-family: inherit;
  font-weight: 400;
  cursor: pointer;
  text-align: left;
  transition: background 0.12s, color 0.12s;
}

.nav-subitem:hover {
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
  color: var(--color-text);
}

.nav-subitem.active {
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  color: var(--color-accent);
  font-weight: 500;
}

.cat-icon {
  flex-shrink: 0;
}

/* ── Right pane ───────────────────────────────────────────────────────────── */
.settings-pane {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px 32px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* ── Pane header ──────────────────────────────────────────────────────────── */
.pane-header {
  flex-shrink: 0;
}

.pane-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0 0 4px;
}

/* legacy stubs */
.subsection-heading { display: none; }
.subsection-divider { display: none; }
.tab-bar { display: none; }
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
  width: 100%;
  transition: border-color 0.15s;
}

.modal-input::placeholder {
  color: var(--color-text-muted);
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
  appearance: none;
  -webkit-appearance: none;
  width: 15px;
  height: 15px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
  background: var(--color-surface);
  cursor: pointer;
  flex-shrink: 0;
  position: relative;
  transition: background 0.12s, border-color 0.12s;
}

.toggle-checkbox:checked {
  background: var(--color-accent);
  border-color: var(--color-accent);
}

.toggle-checkbox:checked::after {
  content: '';
  position: absolute;
  left: 4px;
  top: 1px;
  width: 5px;
  height: 8px;
  border: 1.5px solid #fff;
  border-top: none;
  border-left: none;
  transform: rotate(45deg);
}

.toggle-checkbox:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 1px;
}
.toggle-label {
  font-size: 13px;
  color: var(--color-text);
}

/* ── Web Search setting ───────────────────────────────────────────────────── */
.web-search-setting {
  border-bottom: 1px solid var(--color-border);
  padding-bottom: 16px;
  margin-bottom: 4px;
}
.web-search-enabled-hint {
  color: var(--color-accent);
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
  justify-content: flex-end;
  margin-bottom: 10px;
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
  color: var(--color-danger);
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
  background: var(--color-danger-subtle);
  color: var(--color-danger);
}
.source-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ── Delete confirmation inline strip ────────────────────────────────────── */
.delete-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  background: var(--color-danger-subtle);
  border-top: 1px solid var(--color-danger-border);
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
  background: var(--color-danger);
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

/* ── LLM Providers tab ────────────────────────────────────────────────────── */
.providers-empty {
  padding: 24px 0 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.providers-empty p {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
}

.add-provider-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 14px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  margin-top: 4px;
}
.add-provider-btn:hover {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.add-provider-picker {
  border: 1px solid var(--color-border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 12px;
  background: color-mix(in srgb, var(--color-surface) 80%, var(--color-bg));
}

.provider-option-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.provider-chip {
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.provider-chip:hover {
  background: var(--color-hover);
  border-color: var(--color-text-muted);
}

.cancel-add-provider-btn {
  font-size: 11px;
  color: var(--color-text-muted);
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.cancel-add-provider-btn:hover { color: var(--color-text); }

/* ── AI Features tab ──────────────────────────────────────────────────────── */
.chains-empty {
  padding: 24px 0 8px;
}
.chains-empty p {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
}

.feature-chains {
  display: flex;
  flex-direction: column;
}

/* ── Personalization tab ─────────────────────────────────────────────────── */
.personalization-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.personalization-input {
  /* Allow taller content than the default 120px chat input */
  --rich-input-max-height: 240px;
}

.personalization-input :deep(.rich-input) {
  max-height: 240px;
  min-height: 80px;
}

</style>
