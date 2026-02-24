<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { Plus, Pencil, X } from 'lucide-vue-next'
import NoteEditor from './components/NoteEditor.vue'
import NoteList from './components/NoteList.vue'
import EntityList from './components/EntityList.vue'
import EntityDetail from './components/EntityDetail.vue'
import EntityTypeModal from './components/EntityTypeModal.vue'
import TrashView from './components/TrashView.vue'
import LucideIcon from './components/LucideIcon.vue'
import TabBar from './components/TabBar.vue'
import {
  tabs,
  activeTabId,
  activeTab,
  activePane,
  openContent,
  setActiveTab,
  setActivePaneInTab,
  closePane,
  closeTab,
  updatePaneTitle,
  closePanesForContent,
} from './stores/tabStore'
import type { OpenMode } from './stores/tabStore'

type NavItem = {
  id: string
  label: string
  icon: string
}

type EntityTypeRow = {
  id: string
  name: string
  icon: string
  color: string | null
  schema: string
}

const FIXED_TOP_NAV: NavItem[] = [
  { id: 'today',    label: 'Today',    icon: 'sun' },
  { id: 'notes',    label: 'Notes',    icon: 'file-text' },
]

const FIXED_BOTTOM_NAV: NavItem[] = [
  { id: 'actions',  label: 'Actions',  icon: 'check-square' },
  { id: 'calendar', label: 'Calendar', icon: 'calendar' },
  { id: 'search',   label: 'Search',   icon: 'search' },
  { id: 'trash',    label: 'Trash',    icon: 'trash-2' },
]

const activeView = ref<string>('today')

// List pane refs
const noteListRef = ref<InstanceType<typeof NoteList> | null>(null)
const entityListRef = ref<InstanceType<typeof EntityList> | null>(null)

// Entity types
const entityTypes = ref<EntityTypeRow[]>([])
const showNewEntityTypeModal = ref(false)
const editingEntityType = ref<EntityTypeRow | null>(null)

// Derived: which content ID is active in the active pane (for list highlighting)
const activeNoteId = computed((): string | null => {
  const pane = activePane.value
  return pane?.type === 'note' ? pane.contentId : null
})

const activeEntityId = computed((): string | null => {
  const pane = activePane.value
  return pane?.type === 'entity' ? pane.contentId : null
})

async function loadEntityTypes(): Promise<void> {
  entityTypes.value = (await window.api.invoke('entity-types:list')) as EntityTypeRow[]
}

function isEntityView(viewId: string): boolean {
  return entityTypes.value.some((t) => t.id === viewId)
}

function activeEntityType(): EntityTypeRow | undefined {
  return entityTypes.value.find((t) => t.id === activeView.value)
}

// ── Note actions ────────────────────────────────────────────────────────────

async function newNote(): Promise<void> {
  const note = (await window.api.invoke('notes:create')) as { id: string }
  openContent('note', note.id, 'Untitled', 'default', undefined, 'file-text')
  await noteListRef.value?.refresh()
}

async function openFirstOrNewNote(): Promise<void> {
  if (tabs.value.length > 0) return
  const list = (await window.api.invoke('notes:list')) as { id: string }[]
  if (list.length > 0) {
    openContent('note', list[0].id, 'Untitled', 'default', undefined, 'file-text')
  } else {
    await newNote()
  }
}

function openNote(id: string, mode: OpenMode): void {
  openContent('note', id, 'Untitled', mode, undefined, 'file-text')
}

// ── Entity actions ───────────────────────────────────────────────────────────

async function createEntity(): Promise<void> {
  const typeId = activeView.value
  const et = activeEntityType()
  const entity = (await window.api.invoke('entities:create', {
    type_id: typeId,
    name: 'Untitled',
  })) as { id: string }
  openContent('entity', entity.id, 'Untitled', 'default', typeId, et?.icon ?? 'tag', et?.color ?? undefined)
  await entityListRef.value?.refresh()
}

function openEntityFromList(id: string, mode: OpenMode): void {
  const et = activeEntityType()
  openContent('entity', id, 'Untitled', mode, activeView.value, et?.icon ?? 'tag', et?.color ?? undefined)
}

// ── Navigation ───────────────────────────────────────────────────────────────

async function onNavClick(id: string): Promise<void> {
  activeView.value = id
  if (id === 'notes' && tabs.value.length === 0) {
    await openFirstOrNewNote()
  }
}

// ── Event handlers from child components ────────────────────────────────────

function onNoteSaved(noteId: string, title: string): void {
  updatePaneTitle(noteId, title)
  noteListRef.value?.refresh()
}

function onEntitySaved(entityId: string, name: string): void {
  updatePaneTitle(entityId, name)
  entityListRef.value?.refresh()
}

function onOpenEntity({ entityId, typeId, mode }: { entityId: string; typeId: string; mode: OpenMode }): void {
  if (mode === 'default') {
    // Switch sidebar to the entity type view on a plain open
    activeView.value = typeId
  }
  const et = entityTypes.value.find((t) => t.id === typeId)
  openContent('entity', entityId, 'Untitled', mode, typeId, et?.icon ?? 'tag', et?.color ?? undefined)
}

function onEntityTrashed(entityId: string): void {
  closePanesForContent(entityId)
  entityListRef.value?.refresh()
}

// ── Entity type modal ────────────────────────────────────────────────────────

function openEditModal(et: EntityTypeRow, event: MouseEvent): void {
  event.stopPropagation()
  editingEntityType.value = et
}

function closeModal(): void {
  showNewEntityTypeModal.value = false
  editingEntityType.value = null
}

function onEntityTypeCreated(entityType: EntityTypeRow): void {
  closeModal()
  loadEntityTypes().then(() => {
    activeView.value = entityType.id
  })
}

function onEntityTypeUpdated(entityType: EntityTypeRow): void {
  closeModal()
  loadEntityTypes().then(() => {
    if (activeView.value !== entityType.id) {
      activeView.value = entityType.id
    }
  })
}

onMounted(loadEntityTypes)
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-top" />

      <nav class="sidebar-nav">
        <!-- Fixed top nav items -->
        <button
          v-for="item in FIXED_TOP_NAV"
          :key="item.id"
          class="nav-item"
          :class="{ active: activeView === item.id }"
          @click="onNavClick(item.id)"
        >
          <span class="nav-icon"><LucideIcon :name="item.icon" :size="14" /></span>
          <span class="nav-label">{{ item.label }}</span>
        </button>

        <!-- Dynamic entity type section -->
        <div class="nav-section-label">Entities</div>

        <div
          v-for="et in entityTypes"
          :key="et.id"
          class="nav-item-wrapper"
          :class="{ active: activeView === et.id }"
          @click="onNavClick(et.id)"
        >
          <span class="nav-icon">
            <LucideIcon :name="et.icon" :size="14" :color="et.color ?? undefined" />
          </span>
          <span
            class="nav-label"
            :style="activeView === et.id && et.color ? { color: et.color } : {}"
          >{{ et.name }}</span>
          <button
            class="nav-item-edit-btn"
            title="Edit entity type"
            @click="openEditModal(et, $event)"
          >
            <Pencil :size="11" />
          </button>
        </div>

        <button class="nav-item nav-item-add-type" @click="showNewEntityTypeModal = true">
          <span class="nav-icon"><Plus :size="13" /></span>
          <span class="nav-label">New entity type</span>
        </button>

        <div class="nav-divider" />

        <!-- Fixed bottom nav items -->
        <button
          v-for="item in FIXED_BOTTOM_NAV"
          :key="item.id"
          class="nav-item"
          :class="{ active: activeView === item.id }"
          @click="onNavClick(item.id)"
        >
          <span class="nav-icon"><LucideIcon :name="item.icon" :size="14" /></span>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <div class="sidebar-bottom">
        <button class="nav-item">
          <span class="nav-icon"><LucideIcon name="settings" :size="14" /></span>
          <span class="nav-label">Settings</span>
        </button>
      </div>
    </aside>

    <main class="main-area">

      <!-- Notes + Entity views share the same two-column layout -->
      <template v-if="activeView === 'notes' || isEntityView(activeView)">
        <div class="notes-view">

          <!-- Left list pane -->
          <NoteList
            v-if="activeView === 'notes'"
            ref="noteListRef"
            :active-note-id="activeNoteId"
            @select="openNote($event, 'default')"
            @open-new-pane="openNote($event, 'new-pane')"
            @open-new-tab="openNote($event, 'new-tab')"
            @new-note="newNote"
          />
          <EntityList
            v-else-if="isEntityView(activeView)"
            ref="entityListRef"
            :type-id="activeView"
            :type-name="activeEntityType()?.name ?? ''"
            :active-entity-id="activeEntityId"
            @select="openEntityFromList($event, 'default')"
            @open-new-pane="openEntityFromList($event, 'new-pane')"
            @open-new-tab="openEntityFromList($event, 'new-tab')"
            @new-entity="createEntity"
          />

          <!-- Right content area: tab bar + panes -->
          <div class="content-area">

            <!-- Tab bar (shown only when ≥2 tabs are open) -->
            <TabBar
              v-if="tabs.length > 1"
              :tabs="tabs"
              :active-tab-id="activeTabId"
              @set-active-tab="setActiveTab"
              @close-tab="closeTab"
            />

            <!-- Panes -->
            <div v-if="activeTab && activeTab.panes.length > 0" class="panes-container">
              <div
                v-for="pane in activeTab.panes"
                :key="pane.id"
                class="pane"
                :class="{
                  'pane-active': pane.id === activeTab.activePaneId,
                  'pane-split': activeTab.panes.length > 1,
                }"
                @click.self="setActivePaneInTab(activeTabId, pane.id)"
              >
                <!-- Pane header (only shown when split) -->
                <div
                  v-if="activeTab.panes.length > 1"
                  class="pane-header"
                  @click="setActivePaneInTab(activeTabId, pane.id)"
                >
                  <span class="pane-header-icon">
                    <LucideIcon :name="pane.icon" :size="12" :color="pane.color ?? undefined" />
                  </span>
                  <span class="pane-header-title">{{ pane.title || 'Untitled' }}</span>
                  <button
                    class="pane-header-close"
                    title="Close pane"
                    @click.stop="closePane(activeTabId, pane.id)"
                  >
                    <X :size="11" />
                  </button>
                </div>

                <NoteEditor
                  v-if="pane.type === 'note'"
                  :note-id="pane.contentId"
                  @loaded="(t) => updatePaneTitle(pane.contentId, t)"
                  @saved="(t) => onNoteSaved(pane.contentId, t)"
                  @open-entity="onOpenEntity"
                />
                <EntityDetail
                  v-else-if="pane.type === 'entity'"
                  :entity-id="pane.contentId"
                  @loaded="(n) => updatePaneTitle(pane.contentId, n)"
                  @saved="(n) => onEntitySaved(pane.contentId, n)"
                  @trashed="onEntityTrashed"
                />
              </div>
            </div>

            <!-- Placeholder when no panes are open -->
            <div v-else class="placeholder">
              <template v-if="activeView === 'notes'">
                <span class="placeholder-icon"><LucideIcon name="file-text" :size="48" /></span>
                <h2>Notes</h2>
                <button class="btn-primary" @click="newNote">New Note</button>
              </template>
              <template v-else>
                <span class="placeholder-icon">
                  <LucideIcon
                    :name="activeEntityType()?.icon ?? 'tag'"
                    :size="48"
                    :color="activeEntityType()?.color ?? undefined"
                  />
                </span>
                <h2>{{ activeEntityType()?.name }}</h2>
                <button class="btn-primary" @click="createEntity">
                  New {{ activeEntityType()?.name }}
                </button>
              </template>
            </div>

          </div>
        </div>
      </template>

      <!-- Trash view -->
      <template v-else-if="activeView === 'trash'">
        <TrashView />
      </template>

      <!-- All other fixed views -->
      <template v-else>
        <div class="placeholder">
          <span class="placeholder-icon">
            <LucideIcon
              :name="[...FIXED_TOP_NAV, ...FIXED_BOTTOM_NAV].find(n => n.id === activeView)?.icon ?? 'circle'"
              :size="48"
            />
          </span>
          <h2>{{ [...FIXED_TOP_NAV, ...FIXED_BOTTOM_NAV].find(n => n.id === activeView)?.label }}</h2>
          <p>Coming soon.</p>
        </div>
      </template>
    </main>

    <!-- Create entity type modal -->
    <EntityTypeModal
      v-if="showNewEntityTypeModal"
      @created="onEntityTypeCreated"
      @cancel="closeModal"
    />

    <!-- Edit entity type modal -->
    <EntityTypeModal
      v-if="editingEntityType"
      :editing-type="editingEntityType"
      @updated="onEntityTypeUpdated"
      @cancel="closeModal"
    />
  </div>
</template>

<style scoped>
.nav-section-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
  padding: 10px 10px 4px;
  opacity: 0.6;
}

.nav-divider {
  height: 1px;
  background: var(--color-border);
  margin: 6px 10px;
}

/* Wrapper div that mimics .nav-item but holds the edit button */
.nav-item-wrapper {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 6px;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 13px;
  position: relative;
  user-select: none;
}

.nav-item-wrapper:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--color-text);
}

.nav-item-wrapper.active {
  background: rgba(255, 255, 255, 0.08);
  color: var(--color-text);
}

.nav-item-wrapper .nav-icon {
  width: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.nav-item-wrapper .nav-label {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-item-edit-btn {
  display: none;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  color: var(--color-text-muted);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
  flex-shrink: 0;
}

.nav-item-wrapper:hover .nav-item-edit-btn {
  display: flex;
}

.nav-item-edit-btn:hover {
  color: var(--color-text);
  background: rgba(255, 255, 255, 0.1);
}

.nav-item-add-type {
  font-style: italic;
  opacity: 0.7;
}

.nav-item-add-type:hover {
  opacity: 1;
}

/* ── Content area & panes ──────────────────────────────────────────────────── */

.content-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panes-container {
  flex: 1;
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

.pane.pane-split + .pane.pane-split {
  border-left: 1px solid var(--color-border);
}

.pane.pane-split.pane-active > .pane-header {
  background: rgba(91, 141, 239, 0.06);
}

.pane-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px 0 14px;
  height: 34px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  cursor: pointer;
  flex-shrink: 0;
  user-select: none;
}

.pane-header:hover {
  background: rgba(255, 255, 255, 0.03);
}

.pane-header-icon {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  opacity: 0.6;
}

.pane.pane-active .pane-header-icon {
  opacity: 1;
}

.pane-header-title {
  flex: 1;
  font-size: 12px;
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pane.pane-active .pane-header-title {
  color: var(--color-text);
}

.pane-header-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  background: transparent;
  border: none;
  border-radius: 3px;
  color: var(--color-text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.1s;
  flex-shrink: 0;
}

.pane-header:hover .pane-header-close {
  opacity: 0.6;
}

.pane-header-close:hover {
  opacity: 1 !important;
  background: rgba(255, 255, 255, 0.1);
  color: var(--color-text);
}
</style>
