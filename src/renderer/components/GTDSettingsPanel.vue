<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import LucideIcon from './LucideIcon.vue'
import { CalendarCheck } from 'lucide-vue-next'

interface EntityTypeRow {
  id: string
  name: string
  icon: string
  color: string | null
}

const entityTypes = ref<EntityTypeRow[]>([])

// Project entity type
const gtdProjectEntityTypeId = ref('')

// Default context tag (e.g. "@computer")
const gtdDefaultContext = ref('')

// Follow-up: staleness days (moved here from AI > Follow-up tab)
const followupStalenessDays = ref(7)

// Weekly review
const lastReviewAt = ref<string | null>(null)
const saving = ref(false)

const formattedLastReview = computed(() => {
  if (!lastReviewAt.value) return 'Never'
  return new Date(lastReviewAt.value).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric', year: 'numeric',
  })
})

async function load(): Promise<void> {
  const [types, projectTypeId, defaultCtx, stalenessDays, lastReview] = await Promise.all([
    window.api.invoke('entity-types:list') as Promise<EntityTypeRow[]>,
    window.api.invoke('settings:get', { key: 'gtd_project_entity_type_id' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'gtd_default_context' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'followup_staleness_days' }) as Promise<string | null>,
    window.api.invoke('settings:get', { key: 'gtd_last_review_at' }) as Promise<string | null>,
  ])
  entityTypes.value = types
  gtdProjectEntityTypeId.value = projectTypeId ?? ''
  gtdDefaultContext.value = defaultCtx ?? ''
  followupStalenessDays.value = stalenessDays ? parseInt(stalenessDays, 10) : 7
  lastReviewAt.value = lastReview
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await Promise.all([
      window.api.invoke('settings:set', { key: 'gtd_project_entity_type_id', value: gtdProjectEntityTypeId.value }),
      window.api.invoke('settings:set', { key: 'gtd_default_context', value: gtdDefaultContext.value }),
      window.api.invoke('settings:set', { key: 'followup_staleness_days', value: String(followupStalenessDays.value) }),
    ])
  } finally {
    saving.value = false
  }
}

async function markReviewedNow(): Promise<void> {
  const now = new Date().toISOString()
  await window.api.invoke('settings:set', { key: 'gtd_last_review_at', value: now })
  lastReviewAt.value = now
}

onMounted(load)
</script>

<template>
  <div class="gtd-settings">

    <!-- ── GTD Dashboard ─────────────────────────────────────────────────── -->
    <div class="settings-group">
      <div class="group-label">GTD Dashboard</div>

      <div class="field-row">
        <label class="field-label" for="gtd-project-type">Project entity type</label>
        <div class="field-control">
          <select id="gtd-project-type" v-model="gtdProjectEntityTypeId" class="select-input">
            <option value="">(none)</option>
            <option
              v-for="et in entityTypes"
              :key="et.id"
              :value="et.id"
            >{{ et.name }}</option>
          </select>
          <div v-if="gtdProjectEntityTypeId" class="type-preview">
            <LucideIcon
              :name="entityTypes.find(t => t.id === gtdProjectEntityTypeId)?.icon ?? 'folder'"
              :size="12"
            />
            <span>{{ entityTypes.find(t => t.id === gtdProjectEntityTypeId)?.name }}</span>
          </div>
        </div>
        <p class="field-hint">Entity type used as GTD projects. Tasks can be assigned to a project when promoting or editing.</p>
      </div>

      <div class="field-row">
        <label class="field-label" for="gtd-default-context">Default context tag</label>
        <input
          id="gtd-default-context"
          v-model="gtdDefaultContext"
          type="text"
          class="text-input"
          placeholder="e.g. @computer"
          spellcheck="false"
        />
        <p class="field-hint">Optional default GTD context applied when inserting a new blank task. Use the <code>@tag</code> format.</p>
      </div>
    </div>

    <!-- ── Follow-up Intelligence ─────────────────────────────────────────── -->
    <div class="settings-group">
      <div class="group-label">Follow-up Intelligence</div>

      <div class="field-row">
        <label class="field-label" for="staleness-days">Staleness threshold</label>
        <div class="field-control field-control--inline">
          <input
            id="staleness-days"
            v-model.number="followupStalenessDays"
            type="number"
            class="number-input"
            min="1"
            max="90"
          />
          <span class="field-suffix">days</span>
        </div>
        <p class="field-hint">Tasks with no updates after this many days are flagged as stale in the Weekly Review and Daily Brief.</p>
      </div>
    </div>

    <!-- ── Weekly Review ──────────────────────────────────────────────────── -->
    <div class="settings-group">
      <div class="group-label">Weekly Review</div>

      <div class="review-row">
        <div class="review-meta">
          <CalendarCheck :size="13" class="review-icon" />
          <span>Last reviewed: <strong>{{ formattedLastReview }}</strong></span>
        </div>
        <button class="btn-mark-reviewed" @click="markReviewedNow">
          Mark reviewed now
        </button>
      </div>
    </div>

    <!-- ── Save ───────────────────────────────────────────────────────────── -->
    <div class="save-row">
      <button class="btn-save" :disabled="saving" @click="save">
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.gtd-settings {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.group-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--color-text-muted);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--color-border);
}

.field-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
}

.field-control {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-control--inline {
  flex-direction: row;
  align-items: center;
}

.field-hint {
  font-size: 11px;
  color: var(--color-text-muted);
  margin: 0;
  opacity: 0.7;
  line-height: 1.4;
}

.field-hint code {
  font-family: monospace;
  background: var(--color-hover);
  padding: 1px 4px;
  border-radius: 3px;
}

.select-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 7px 28px 7px 10px;
  width: 100%;
  max-width: 280px;
  cursor: pointer;
  outline: none;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  transition: border-color 0.15s;
}

.select-input:focus {
  border-color: var(--color-accent);
}

.type-preview {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--color-text-muted);
  padding: 2px 0;
}

.text-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 7px 10px;
  width: 100%;
  max-width: 280px;
  outline: none;
  transition: border-color 0.15s;
}

.text-input::placeholder {
  color: var(--color-text-muted);
}

.text-input:focus {
  border-color: var(--color-accent);
}

.number-input {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  padding: 7px 10px;
  width: 72px;
  text-align: center;
  outline: none;
  transition: border-color 0.15s;
}

.number-input:focus {
  border-color: var(--color-accent);
}

.field-suffix {
  font-size: 13px;
  color: var(--color-text-muted);
  margin-left: 8px;
}

/* Weekly review row */
.review-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 8px;
  gap: 12px;
}

.review-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--color-text-muted);
}

.review-icon {
  color: var(--color-accent);
  flex-shrink: 0;
}

.btn-mark-reviewed {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
}

.btn-mark-reviewed:hover {
  opacity: 0.9;
}

/* Save button */
.save-row {
  display: flex;
  justify-content: flex-end;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.btn-save {
  padding: 7px 20px;
  background: var(--color-accent);
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
}

.btn-save:disabled {
  opacity: 0.6;
  cursor: default;
}

.btn-save:not(:disabled):hover {
  opacity: 0.9;
}
</style>
