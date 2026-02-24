<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { Plus, Pencil } from 'lucide-vue-next'
import NoteEditor from './components/NoteEditor.vue'
import NoteList from './components/NoteList.vue'
import EntityList from './components/EntityList.vue'
import EntityDetail from './components/EntityDetail.vue'
import EntityTypeModal from './components/EntityTypeModal.vue'
import LucideIcon from './components/LucideIcon.vue'

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
]

const activeView = ref<string>('today')

// Notes state
const activeNoteId = ref<string | null>(null)
const noteListRef = ref<InstanceType<typeof NoteList> | null>(null)

// Entity state
const entityTypes = ref<EntityTypeRow[]>([])
const activeEntityId = ref<string | null>(null)
const entityListRef = ref<InstanceType<typeof EntityList> | null>(null)
const showNewEntityTypeModal = ref(false)
const editingEntityType = ref<EntityTypeRow | null>(null)

async function loadEntityTypes(): Promise<void> {
  entityTypes.value = (await window.api.invoke('entity-types:list')) as EntityTypeRow[]
}

function isEntityView(viewId: string): boolean {
  return entityTypes.value.some((t) => t.id === viewId)
}

function activeEntityType(): EntityTypeRow | undefined {
  return entityTypes.value.find((t) => t.id === activeView.value)
}

// Notes actions
async function newNote(): Promise<void> {
  const note = (await window.api.invoke('notes:create')) as { id: string }
  activeNoteId.value = note.id
  await noteListRef.value?.refresh()
}

async function openFirstOrNewNote(): Promise<void> {
  const list = (await window.api.invoke('notes:list')) as { id: string }[]
  if (list.length > 0) {
    activeNoteId.value = list[0].id
  } else {
    await newNote()
  }
}

// Entity actions
async function createEntity(): Promise<void> {
  const typeId = activeView.value
  const entity = (await window.api.invoke('entities:create', {
    type_id: typeId,
    name: 'Untitled',
  })) as { id: string }
  activeEntityId.value = entity.id
  await entityListRef.value?.refresh()
}

async function onNavClick(id: string): Promise<void> {
  activeView.value = id
  activeEntityId.value = null
  if (id === 'notes' && !activeNoteId.value) {
    await openFirstOrNewNote()
  }
}

function onNoteSelect(id: string): void {
  activeNoteId.value = id === '' ? null : id
}

function onNoteSaved(): void {
  noteListRef.value?.refresh()
}

function onOpenEntity({ entityId, typeId }: { entityId: string; typeId: string }): void {
  activeView.value = typeId
  activeEntityId.value = entityId
}

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
    activeEntityId.value = null
  })
}

function onEntityTypeUpdated(entityType: EntityTypeRow): void {
  closeModal()
  // Refresh sidebar; if we're currently viewing this type, EntityDetail will
  // re-render naturally since entityTypes drives the nav label.
  loadEntityTypes().then(() => {
    // Stay on the same view, just ensure activeEntityId is intact
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
      <!-- Notes view -->
      <template v-if="activeView === 'notes'">
        <div class="notes-view">
          <NoteList
            ref="noteListRef"
            :active-note-id="activeNoteId"
            @select="onNoteSelect"
            @new-note="newNote"
          />
          <NoteEditor
            v-if="activeNoteId"
            :note-id="activeNoteId"
            @saved="onNoteSaved"
            @open-entity="onOpenEntity"
          />
          <div v-else class="placeholder">
            <span class="placeholder-icon"><LucideIcon name="file-text" :size="48" /></span>
            <h2>Notes</h2>
            <button class="btn-primary" @click="newNote">New Note</button>
          </div>
        </div>
      </template>

      <!-- Entity type views (dynamic) -->
      <template v-else-if="isEntityView(activeView)">
        <div class="notes-view">
          <EntityList
            ref="entityListRef"
            :type-id="activeView"
            :type-name="activeEntityType()?.name ?? ''"
            :active-entity-id="activeEntityId"
            @select="activeEntityId = $event === '' ? null : $event"
            @new-entity="createEntity"
          />
          <EntityDetail
            v-if="activeEntityId"
            :entity-id="activeEntityId"
            @saved="entityListRef?.refresh()"
          />
          <div v-else class="placeholder">
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
          </div>
        </div>
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
</style>
