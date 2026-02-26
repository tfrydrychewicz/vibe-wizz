<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { X, Check, Loader2, ChevronDown, ChevronRight, Copy, CheckCheck, Link2, AlertCircle } from 'lucide-vue-next'

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

interface DiscoveredCalendar {
  id: string
  name: string
  primary: boolean
}

const props = defineProps<{
  source?: CalendarSource
}>()

const emit = defineEmits<{
  saved: [CalendarSource]
  close: []
}>()

// Step 1 = provider pick (create only); step 2 = configure
const step = ref<1 | 2>(props.source ? 2 : 1)
const selectedProvider = ref(props.source?.provider_id ?? 'google_apps_script')

// Config fields
const sourceName = ref(props.source?.name ?? '')
const syncInterval = ref(props.source?.sync_interval_minutes ?? 60)
const webAppUrl = ref('')
const selectedCalendarIds = ref<string[]>([])

// Parse existing config when editing
if (props.source) {
  try {
    const cfg = JSON.parse(props.source.config) as Record<string, string>
    webAppUrl.value = cfg.webAppUrl ?? ''
    if (cfg.calendarIds) {
      selectedCalendarIds.value = cfg.calendarIds.split(',').map((s) => s.trim()).filter(Boolean)
    }
  } catch {
    // ignore
  }
}

// Verify state
type VerifyState = 'idle' | 'loading' | 'ok' | 'error'
const verifyState = ref<VerifyState>('idle')
const verifyEmail = ref('')
const verifyError = ref('')
const discoveredCalendars = ref<DiscoveredCalendar[]>([])

// Script panel
const appsScriptSource = ref('')
const appsScriptInstructions = ref<string[]>([])
const showInstructions = ref(false)
const copied = ref(false)

// Save
const saving = ref(false)
const saveError = ref('')

const syncIntervalOptions = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '1 hour', value: 60 },
  { label: '6 hours', value: 360 },
  { label: '24 hours', value: 1440 },
]

onMounted(async () => {
  const data = await window.api.invoke('calendar-sources:get-script') as {
    source: string
    instructions: readonly string[]
  }
  appsScriptSource.value = data.source
  appsScriptInstructions.value = [...data.instructions]
})

// ── Verify ────────────────────────────────────────────────────────────────────

async function testConnection(): Promise<void> {
  if (!webAppUrl.value.trim()) {
    verifyState.value = 'error'
    verifyError.value = 'Web App URL is required.'
    return
  }
  verifyState.value = 'loading'
  verifyEmail.value = ''
  verifyError.value = ''
  discoveredCalendars.value = []

  try {
    const result = await window.api.invoke('calendar-sources:verify', {
      provider_id: selectedProvider.value,
      config: { webAppUrl: webAppUrl.value.trim() },
    }) as { ok: boolean; error?: string; displayName?: string; calendars?: DiscoveredCalendar[] }

    if (result.ok) {
      verifyState.value = 'ok'
      verifyEmail.value = result.displayName ?? ''
      discoveredCalendars.value = result.calendars ?? []
      // Auto-select primary if nothing yet chosen
      if (selectedCalendarIds.value.length === 0) {
        const primary = result.calendars?.find((c) => c.primary)
        if (primary) selectedCalendarIds.value = [primary.id]
      }
    } else {
      verifyState.value = 'error'
      verifyError.value = result.error ?? 'Connection failed.'
    }
  } catch (err) {
    verifyState.value = 'error'
    verifyError.value = err instanceof Error ? err.message : String(err)
  }
}

// ── Calendar selection ────────────────────────────────────────────────────────

function toggleCalendar(calId: string): void {
  const idx = selectedCalendarIds.value.indexOf(calId)
  if (idx >= 0) {
    selectedCalendarIds.value.splice(idx, 1)
  } else {
    selectedCalendarIds.value.push(calId)
  }
}

// ── Script copy ───────────────────────────────────────────────────────────────

async function copyScript(): Promise<void> {
  await navigator.clipboard.writeText(appsScriptSource.value)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

// ── Save ──────────────────────────────────────────────────────────────────────

async function save(): Promise<void> {
  if (!sourceName.value.trim()) { saveError.value = 'Name is required.'; return }
  if (!webAppUrl.value.trim()) { saveError.value = 'Web App URL is required.'; return }

  saving.value = true
  saveError.value = ''

  const config: Record<string, string> = { webAppUrl: webAppUrl.value.trim() }
  if (selectedCalendarIds.value.length > 0) {
    config.calendarIds = selectedCalendarIds.value.join(',')
  }

  try {
    let result: CalendarSource
    if (props.source) {
      await window.api.invoke('calendar-sources:update', {
        id: props.source.id,
        name: sourceName.value.trim(),
        config,
        sync_interval_minutes: syncInterval.value,
      })
      result = {
        ...props.source,
        name: sourceName.value.trim(),
        config: JSON.stringify(config),
        sync_interval_minutes: syncInterval.value,
      }
    } else {
      result = await window.api.invoke('calendar-sources:create', {
        provider_id: selectedProvider.value,
        name: sourceName.value.trim(),
        config,
        sync_interval_minutes: syncInterval.value,
      }) as CalendarSource
    }
    emit('saved', result)
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="cs-backdrop" @click.self="emit('close')">
    <div class="cs-panel" role="dialog" aria-labelledby="cs-title">

      <!-- Header -->
      <div class="cs-header">
        <h2 id="cs-title" class="cs-title">
          {{ source ? 'Edit Calendar Source' : 'Add Calendar Source' }}
        </h2>
        <button class="cs-close" @click="emit('close')"><X :size="15" /></button>
      </div>

      <!-- Body -->
      <div class="cs-body">

        <!-- ── Step 1: Provider picker ── -->
        <template v-if="step === 1">
          <p class="step-hint">Choose how to connect your calendar.</p>

          <div class="provider-list">
            <button
              class="provider-item active-provider"
              @click="selectedProvider = 'google_apps_script'; step = 2"
            >
              <div class="provider-icon">
                <Link2 :size="18" />
              </div>
              <div class="provider-info">
                <span class="provider-name">Google Apps Script</span>
                <span class="provider-desc">No API key needed — deploy a Web App in your Google account</span>
              </div>
              <ChevronRight :size="14" class="provider-arrow" />
            </button>

            <div class="provider-item provider-soon">
              <div class="provider-icon muted">
                <Link2 :size="18" />
              </div>
              <div class="provider-info">
                <span class="provider-name muted">iCal URL <span class="badge-soon">coming soon</span></span>
                <span class="provider-desc">Sync any public or secret .ics URL</span>
              </div>
            </div>

            <div class="provider-item provider-soon">
              <div class="provider-icon muted">
                <Link2 :size="18" />
              </div>
              <div class="provider-info">
                <span class="provider-name muted">Google Calendar API <span class="badge-soon">coming soon</span></span>
                <span class="provider-desc">OAuth 2.0 — full read/write support</span>
              </div>
            </div>

            <div class="provider-item provider-soon">
              <div class="provider-icon muted">
                <Link2 :size="18" />
              </div>
              <div class="provider-info">
                <span class="provider-name muted">Microsoft Outlook <span class="badge-soon">coming soon</span></span>
                <span class="provider-desc">Microsoft Graph API — full read/write support</span>
              </div>
            </div>
          </div>
        </template>

        <!-- ── Step 2: Configure ── -->
        <template v-else>
          <!-- Back button (create only) -->
          <button v-if="!source" class="back-btn" @click="step = 1">← Back</button>

          <!-- Name + Interval row -->
          <div class="row-two">
            <div class="field-group flex-1">
              <label class="field-label">Name</label>
              <input
                v-model="sourceName"
                class="cs-input"
                placeholder="Work Calendar"
                maxlength="80"
              />
            </div>
            <div class="field-group">
              <label class="field-label">Sync every</label>
              <select v-model="syncInterval" class="cs-input cs-select">
                <option v-for="opt in syncIntervalOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </option>
              </select>
            </div>
          </div>

          <!-- Web App URL -->
          <div class="field-group">
            <label class="field-label">Web App URL</label>
            <div class="url-row">
              <input
                v-model="webAppUrl"
                class="cs-input flex-1"
                placeholder="https://script.google.com/macros/s/.../exec"
                spellcheck="false"
              />
              <button
                class="verify-btn"
                :disabled="verifyState === 'loading'"
                @click="testConnection"
              >
                <Loader2 v-if="verifyState === 'loading'" :size="13" class="spin" />
                <Check v-else-if="verifyState === 'ok'" :size="13" />
                <span>{{ verifyState === 'loading' ? 'Testing…' : 'Test Connection' }}</span>
              </button>
            </div>

            <!-- Verify result -->
            <div v-if="verifyState === 'ok'" class="verify-ok">
              <Check :size="13" />
              <span>Connected as <strong>{{ verifyEmail }}</strong></span>
            </div>
            <div v-else-if="verifyState === 'error'" class="verify-error">
              <AlertCircle :size="13" />
              <span>{{ verifyError }}</span>
            </div>
          </div>

          <!-- Calendar selection (shown after successful verify) -->
          <div v-if="discoveredCalendars.length > 0" class="field-group">
            <label class="field-label">Calendars to sync</label>
            <div class="calendar-list">
              <label
                v-for="cal in discoveredCalendars"
                :key="cal.id"
                class="cal-row"
              >
                <input
                  type="checkbox"
                  class="cal-checkbox"
                  :checked="selectedCalendarIds.includes(cal.id)"
                  @change="toggleCalendar(cal.id)"
                />
                <span class="cal-name">{{ cal.name }}</span>
                <span v-if="cal.primary" class="cal-primary-badge">primary</span>
              </label>
            </div>
          </div>

          <!-- Existing calendars hint (when editing without re-verifying) -->
          <div v-else-if="selectedCalendarIds.length > 0" class="field-group">
            <label class="field-label">Calendars to sync</label>
            <p class="field-hint">
              {{ selectedCalendarIds.length }} calendar{{ selectedCalendarIds.length !== 1 ? 's' : '' }} configured.
              Run Test Connection to review or change the selection.
            </p>
          </div>

          <!-- Setup instructions (collapsible) -->
          <div class="instructions-section">
            <button class="instructions-toggle" @click="showInstructions = !showInstructions">
              <component :is="showInstructions ? ChevronDown : ChevronRight" :size="13" />
              <span>Setup instructions</span>
            </button>

            <template v-if="showInstructions">
              <ol class="instructions-list">
                <li v-for="(step, i) in appsScriptInstructions" :key="i">{{ step }}</li>
              </ol>
              <div class="script-block">
                <div class="script-header">
                  <span class="script-label">Apps Script code</span>
                  <button class="copy-btn" @click="copyScript">
                    <CheckCheck v-if="copied" :size="12" />
                    <Copy v-else :size="12" />
                    <span>{{ copied ? 'Copied!' : 'Copy' }}</span>
                  </button>
                </div>
                <pre class="script-pre"><code>{{ appsScriptSource }}</code></pre>
              </div>
            </template>
          </div>

          <!-- Save error -->
          <p v-if="saveError" class="save-error">{{ saveError }}</p>
        </template>
      </div>

      <!-- Footer -->
      <div class="cs-footer">
        <button class="btn-cancel" @click="emit('close')">Cancel</button>
        <button
          v-if="step === 2"
          class="btn-save"
          :disabled="saving"
          @click="save"
        >
          {{ saving ? 'Saving…' : source ? 'Save changes' : 'Add source' }}
        </button>
      </div>

    </div>
  </div>
</template>

<style scoped>
/* ── Backdrop & panel ──────────────────────────────────────────────────────── */
.cs-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.cs-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  width: 560px;
  max-width: 94vw;
  max-height: 86vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
}

/* ── Header ───────────────────────────────────────────────────────────────── */
.cs-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 14px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.cs-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  margin: 0;
}

.cs-close {
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
.cs-close:hover { color: var(--color-text); }

/* ── Body ─────────────────────────────────────────────────────────────────── */
.cs-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  scrollbar-width: thin;
  scrollbar-color: var(--color-border) transparent;
}

/* ── Step 1: provider list ────────────────────────────────────────────────── */
.step-hint {
  font-size: 13px;
  color: var(--color-text-muted);
  margin: 0;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.provider-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 8px;
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  text-align: left;
  font-family: inherit;
  cursor: default;
  transition: border-color 0.15s, background 0.15s;
}

.active-provider {
  cursor: pointer;
}
.active-provider:hover {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 6%, var(--color-bg));
}

.provider-soon {
  opacity: 0.5;
}

.provider-icon {
  width: 32px;
  height: 32px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.provider-icon.muted {
  background: color-mix(in srgb, var(--color-text-muted) 14%, transparent);
  color: var(--color-text-muted);
}

.provider-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.provider-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}
.provider-name.muted { color: var(--color-text-muted); }

.provider-desc {
  font-size: 12px;
  color: var(--color-text-muted);
}

.badge-soon {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: color-mix(in srgb, var(--color-text-muted) 18%, transparent);
  color: var(--color-text-muted);
  border-radius: 4px;
  padding: 1px 5px;
  vertical-align: middle;
}

.provider-arrow {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

/* ── Step 2: configure ────────────────────────────────────────────────────── */
.back-btn {
  align-self: flex-start;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 0;
  transition: color 0.12s;
  margin-bottom: -4px;
}
.back-btn:hover { color: var(--color-text); }

.row-two {
  display: flex;
  gap: 10px;
  align-items: flex-end;
}

.field-group {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.flex-1 { flex: 1; }

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

.cs-input {
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
.cs-input:focus { border-color: var(--color-accent); }

.cs-select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}

/* ── URL + verify ─────────────────────────────────────────────────────────── */
.url-row {
  display: flex;
  gap: 6px;
}

.verify-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 0 14px;
  height: 34px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  white-space: nowrap;
}
.verify-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-text) 8%, var(--color-surface));
  border-color: var(--color-accent);
}
.verify-btn:disabled { opacity: 0.6; cursor: not-allowed; }

.verify-ok {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #4ade80;
  margin-top: 2px;
}

.verify-error {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #f87171;
  margin-top: 2px;
}

/* ── Calendar selection ───────────────────────────────────────────────────── */
.calendar-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 7px;
  padding: 8px 10px;
}

.cal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 3px 0;
}

.cal-checkbox {
  width: 14px;
  height: 14px;
  accent-color: var(--color-accent);
  cursor: pointer;
  flex-shrink: 0;
}

.cal-name {
  flex: 1;
  font-size: 13px;
  color: var(--color-text);
}

.cal-primary-badge {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 15%, transparent);
  border-radius: 4px;
  padding: 1px 5px;
}

/* ── Setup instructions ───────────────────────────────────────────────────── */
.instructions-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.instructions-toggle {
  display: flex;
  align-items: center;
  gap: 5px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 0;
  transition: color 0.12s;
  align-self: flex-start;
}
.instructions-toggle:hover { color: var(--color-text); }

.instructions-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.instructions-list li {
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
}

.script-block {
  border: 1px solid var(--color-border);
  border-radius: 7px;
  overflow: hidden;
}

.script-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: color-mix(in srgb, var(--color-text) 5%, var(--color-bg));
  border-bottom: 1px solid var(--color-border);
}

.script-label {
  font-size: 11px;
  color: var(--color-text-muted);
  font-weight: 500;
}

.copy-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  font-size: 11px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.12s, background 0.12s;
}
.copy-btn:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 8%, transparent);
}

.script-pre {
  margin: 0;
  padding: 10px;
  background: var(--color-bg);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
  scrollbar-width: thin;
}
.script-pre code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  color: var(--color-text-muted);
  white-space: pre;
}

/* ── Save error ───────────────────────────────────────────────────────────── */
.save-error {
  font-size: 12px;
  color: #f87171;
  margin: 0;
  padding: 8px 10px;
  background: color-mix(in srgb, #f87171 10%, transparent);
  border: 1px solid color-mix(in srgb, #f87171 25%, transparent);
  border-radius: 6px;
}

/* ── Footer ───────────────────────────────────────────────────────────────── */
.cs-footer {
  padding: 12px 20px;
  border-top: 1px solid var(--color-border);
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-shrink: 0;
}

.btn-cancel {
  padding: 7px 16px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  color: var(--color-text-muted);
  font-size: 13px;
  font-family: inherit;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;
}
.btn-cancel:hover { border-color: var(--color-text-muted); color: var(--color-text); }

.btn-save {
  padding: 7px 18px;
  background: var(--color-accent);
  border: none;
  border-radius: 7px;
  color: #fff;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.12s;
}
.btn-save:hover:not(:disabled) { opacity: 0.88; }
.btn-save:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Spinner ──────────────────────────────────────────────────────────────── */
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
