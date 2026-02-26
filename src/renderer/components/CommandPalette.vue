<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { Search } from 'lucide-vue-next'
import LucideIcon from './LucideIcon.vue'
import type { OpenMode } from '../stores/tabStore'

type EntityTypeRow = {
  id: string
  name: string
  icon: string
  color: string | null
}

type TemplateRef = {
  id: string
  name: string
  icon: string
}

type NoteResult = { id: string; title: string }
type EntityResult = { id: string; name: string; type_id?: string; type_name?: string; type_icon?: string }

interface PaletteCommand {
  id: string
  label: string
  subtitle?: string
  iconName: string
  iconColor?: string
  shortcut?: string
  category: 'navigate' | 'create' | 'app' | 'notes' | 'entities'
  run: (mode: OpenMode) => void
}

const props = defineProps<{
  entityTypes: EntityTypeRow[]
  noteTemplates: TemplateRef[]
}>()

const emit = defineEmits<{
  close: []
  navigate: [view: string]
  'new-note': [templateId?: string]
  'new-entity': [typeId: string]
  'open-note': [noteId: string, mode: OpenMode]
  'open-entity': [entityId: string, typeId: string, mode: OpenMode]
}>()

const query = ref('')
const selectedIndex = ref(0)
const inputEl = ref<HTMLInputElement | null>(null)
const resultsEl = ref<HTMLElement | null>(null)

const noteResults = ref<NoteResult[]>([])
const entityResults = ref<EntityResult[]>([])
const isSearching = ref(false)

// ── Static command lists ──────────────────────────────────────────────────────

const navigateCommands = computed((): PaletteCommand[] => [
  { id: 'nav-today',     label: 'Go to Today',     iconName: 'sun',            shortcut: '⌘⇧T', category: 'navigate', run: () => { emit('navigate', 'today') } },
  { id: 'nav-notes',     label: 'Go to Notes',     iconName: 'file-text',      category: 'navigate', run: () => { emit('navigate', 'notes') } },
  { id: 'nav-calendar',  label: 'Go to Calendar',  iconName: 'calendar',       category: 'navigate', run: () => { emit('navigate', 'calendar') } },
  { id: 'nav-actions',   label: 'Go to Actions',   iconName: 'check-square',   category: 'navigate', run: () => { emit('navigate', 'actions') } },
  { id: 'nav-search',    label: 'Go to Search',    iconName: 'search',         shortcut: '⌘F', category: 'navigate', run: () => { emit('navigate', 'search') } },
  { id: 'nav-templates', label: 'Go to Templates', iconName: 'layout-template', category: 'navigate', run: () => { emit('navigate', 'templates') } },
  { id: 'nav-trash',     label: 'Go to Trash',     iconName: 'trash-2',        category: 'navigate', run: () => { emit('navigate', 'trash') } },
  ...props.entityTypes.map((et): PaletteCommand => ({
    id: `nav-et-${et.id}`,
    label: `Go to ${et.name}`,
    iconName: et.icon,
    iconColor: et.color ?? undefined,
    category: 'navigate',
    run: () => { emit('navigate', et.id) },
  })),
])

const createCommands = computed((): PaletteCommand[] => [
  { id: 'create-note', label: 'New Note', iconName: 'plus', shortcut: '⌘N', category: 'create', run: () => { emit('new-note') } },
  ...props.noteTemplates.map((t): PaletteCommand => ({
    id: `create-tmpl-${t.id}`,
    label: `New Note from "${t.name}"`,
    iconName: t.icon,
    category: 'create',
    run: () => { emit('new-note', t.id) },
  })),
  ...props.entityTypes.map((et): PaletteCommand => ({
    id: `create-et-${et.id}`,
    label: `New ${et.name}`,
    iconName: et.icon,
    iconColor: et.color ?? undefined,
    category: 'create',
    run: () => { emit('new-entity', et.id) },
  })),
])

const appCommands: PaletteCommand[] = [
  { id: 'app-chat',     label: 'Toggle AI Chat',  iconName: 'message-square', shortcut: '⌘J', category: 'app', run: () => { emit('navigate', '__chat__') } },
  { id: 'app-settings', label: 'Open Settings',   iconName: 'settings',       shortcut: '⌘,', category: 'app', run: () => { emit('navigate', '__settings__') } },
]

// ── Filtering ─────────────────────────────────────────────────────────────────

function fuzzyMatch(text: string, q: string): boolean {
  if (!q) return true
  const lq = q.toLowerCase()
  const lt = text.toLowerCase()
  // Simple: all chars of query appear in order in text
  let ti = 0
  for (let qi = 0; qi < lq.length; qi++) {
    const idx = lt.indexOf(lq[qi], ti)
    if (idx === -1) return false
    ti = idx + 1
  }
  return true
}

const filteredStaticCommands = computed(() => {
  const q = query.value.trim()
  const filter = (cmds: PaletteCommand[]) => cmds.filter(c => fuzzyMatch(c.label, q))
  return {
    navigate: filter(navigateCommands.value),
    create: filter(createCommands.value),
    app: filter(appCommands),
  }
})

interface Group {
  key: string
  label: string
  commands: PaletteCommand[]
}

const noteCommands = computed((): PaletteCommand[] =>
  noteResults.value.map((n): PaletteCommand => ({
    id: `note-${n.id}`,
    label: n.title,
    iconName: 'file-text',
    category: 'notes',
    run: (mode) => { emit('open-note', n.id, mode) },
  }))
)

const entityCommands = computed((): PaletteCommand[] =>
  entityResults.value.map((e): PaletteCommand => ({
    id: `entity-${e.id}`,
    label: e.name,
    subtitle: e.type_name,
    iconName: e.type_icon ?? 'tag',
    category: 'entities',
    run: (mode) => { emit('open-entity', e.id, e.type_id ?? '', mode) },
  }))
)

const visibleGroups = computed((): Group[] => {
  const groups: Group[] = []
  const { navigate, create, app } = filteredStaticCommands.value

  if (query.value.trim().length >= 2) {
    // With a query: static first, then live search results
    if (noteCommands.value.length > 0)
      groups.push({ key: 'notes', label: 'Notes', commands: noteCommands.value })
    if (entityCommands.value.length > 0)
      groups.push({ key: 'entities', label: 'Entities', commands: entityCommands.value })
    if (navigate.length > 0)
      groups.push({ key: 'navigate', label: 'Navigate', commands: navigate })
    if (create.length > 0)
      groups.push({ key: 'create', label: 'Create', commands: create })
    if (app.length > 0)
      groups.push({ key: 'app', label: 'App', commands: app })
  } else {
    // No query: show all static in order
    if (navigate.length > 0)
      groups.push({ key: 'navigate', label: 'Navigate', commands: navigate })
    if (create.length > 0)
      groups.push({ key: 'create', label: 'Create', commands: create })
    if (app.length > 0)
      groups.push({ key: 'app', label: 'App', commands: app })
  }

  return groups
})

const flatCommands = computed((): PaletteCommand[] =>
  visibleGroups.value.flatMap(g => g.commands)
)

// ── IPC search (debounced) ────────────────────────────────────────────────────

let searchTimer: ReturnType<typeof setTimeout> | null = null

watch(query, (q) => {
  selectedIndex.value = 0
  if (searchTimer) clearTimeout(searchTimer)
  if (q.trim().length < 2) {
    noteResults.value = []
    entityResults.value = []
    isSearching.value = false
    return
  }
  isSearching.value = true
  searchTimer = setTimeout(async () => {
    const [notes, entities] = await Promise.all([
      window.api.invoke('notes:search', { query: q.trim() }) as Promise<NoteResult[]>,
      window.api.invoke('entities:search', { query: q.trim() }) as Promise<EntityResult[]>,
    ])
    noteResults.value = notes
    entityResults.value = entities
    isSearching.value = false
  }, 200)
})

// ── Keyboard navigation ───────────────────────────────────────────────────────

function onKeydown(e: KeyboardEvent): void {
  const total = flatCommands.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = total > 0 ? (selectedIndex.value + 1) % total : 0
    scrollSelectedIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value = total > 0 ? (selectedIndex.value - 1 + total) % total : 0
    scrollSelectedIntoView()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const cmd = flatCommands.value[selectedIndex.value]
    if (cmd) runCommand(cmd, e)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function scrollSelectedIntoView(): void {
  nextTick(() => {
    const el = resultsEl.value?.querySelector<HTMLElement>('.cp-item-active')
    el?.scrollIntoView({ block: 'nearest' })
  })
}

function runCommand(cmd: PaletteCommand, e: MouseEvent | KeyboardEvent): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('close')
  cmd.run(mode)
}

function itemIndex(groupIdx: number, itemIdx: number): number {
  let offset = 0
  for (let i = 0; i < groupIdx; i++) {
    offset += visibleGroups.value[i].commands.length
  }
  return offset + itemIdx
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(() => {
  nextTick(() => inputEl.value?.focus())
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <div class="cp-backdrop" @click.self="emit('close')">
    <div class="cp-modal" role="dialog" aria-label="Command palette">

      <!-- Search input row -->
      <div class="cp-input-row">
        <Search :size="15" class="cp-search-icon" />
        <input
          ref="inputEl"
          v-model="query"
          class="cp-input"
          placeholder="Go to, create, search…"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <kbd class="cp-esc-hint">esc</kbd>
      </div>

      <!-- Results -->
      <div ref="resultsEl" class="cp-results">

        <template v-if="flatCommands.length > 0">
          <template v-for="(group, gi) in visibleGroups" :key="group.key">
            <div class="cp-group-header">{{ group.label }}</div>
            <button
              v-for="(cmd, ci) in group.commands"
              :key="cmd.id"
              class="cp-item"
              :class="{ 'cp-item-active': itemIndex(gi, ci) === selectedIndex }"
              @mouseenter="selectedIndex = itemIndex(gi, ci)"
              @click="runCommand(cmd, $event)"
            >
              <span class="cp-item-icon">
                <LucideIcon :name="cmd.iconName" :size="13" :color="cmd.iconColor" />
              </span>
              <span class="cp-item-label">{{ cmd.label }}</span>
              <span v-if="cmd.subtitle" class="cp-item-subtitle">{{ cmd.subtitle }}</span>
              <kbd v-if="cmd.shortcut" class="cp-kbd">{{ cmd.shortcut }}</kbd>
            </button>
          </template>
        </template>

        <div v-else-if="isSearching" class="cp-empty">Searching…</div>
        <div v-else-if="query.trim()" class="cp-empty">No results for "{{ query }}"</div>
        <div v-else class="cp-empty cp-empty-hint">Type to filter commands or search notes</div>

      </div>

      <!-- Footer hint -->
      <div class="cp-footer">
        <span class="cp-hint"><kbd>↑↓</kbd> navigate</span>
        <span class="cp-hint"><kbd>↵</kbd> open</span>
        <span class="cp-hint"><kbd>⇧↵</kbd> new pane</span>
        <span class="cp-hint"><kbd>⌘↵</kbd> new tab</span>
        <span class="cp-hint"><kbd>esc</kbd> close</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 80px;
  z-index: 1100;
}

.cp-modal {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  width: 580px;
  max-width: 94vw;
  max-height: calc(100vh - 120px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
}

/* ── Input row ─────────────────────────────────────────────────────────────── */

.cp-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.cp-search-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.cp-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 14px;
  color: var(--color-text);
  font-family: inherit;
  min-width: 0;
}

.cp-input::placeholder {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.cp-esc-hint {
  font-size: 10px;
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  flex-shrink: 0;
  font-family: inherit;
}

/* ── Results ───────────────────────────────────────────────────────────────── */

.cp-results {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  min-height: 0;
}

.cp-group-header {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  opacity: 0.55;
  padding: 8px 14px 3px;
  pointer-events: none;
  user-select: none;
}

.cp-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 14px;
  background: transparent;
  border: none;
  cursor: pointer;
  text-align: left;
  color: var(--color-text);
  font-size: 13px;
  font-family: inherit;
  transition: background 0.08s;
}

.cp-item:hover,
.cp-item-active {
  background: rgba(255, 255, 255, 0.06);
}

.cp-item-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  opacity: 0.7;
  width: 16px;
}

.cp-item-active .cp-item-icon {
  opacity: 1;
}

.cp-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cp-item-subtitle {
  font-size: 11px;
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-right: 4px;
}

.cp-kbd {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  flex-shrink: 0;
  font-family: inherit;
  white-space: nowrap;
}

/* ── Empty / loading state ─────────────────────────────────────────────────── */

.cp-empty {
  padding: 20px 14px;
  font-size: 13px;
  color: var(--color-text-muted);
  text-align: center;
}

.cp-empty-hint {
  opacity: 0.5;
  font-style: italic;
}

/* ── Footer ────────────────────────────────────────────────────────────────── */

.cp-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.cp-hint {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.55;
}

.cp-hint kbd {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid var(--color-border);
  font-family: inherit;
}
</style>
