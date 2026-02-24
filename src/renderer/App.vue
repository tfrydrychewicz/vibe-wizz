<script setup lang="ts">
import { ref } from 'vue'
import NoteEditor from './components/NoteEditor.vue'
import NoteList from './components/NoteList.vue'

type NavItem = {
  id: string
  label: string
  icon: string
}

const navItems: NavItem[] = [
  { id: 'today',    label: 'Today',    icon: '📋' },
  { id: 'notes',    label: 'Notes',    icon: '📝' },
  { id: 'people',   label: 'People',   icon: '👥' },
  { id: 'projects', label: 'Projects', icon: '📁' },
  { id: 'actions',  label: 'Actions',  icon: '✅' },
  { id: 'calendar', label: 'Calendar', icon: '📅' },
  { id: 'search',   label: 'Search',   icon: '🔍' },
]

const activeView = ref<string>('today')
const activeNoteId = ref<string | null>(null)
const noteListRef = ref<InstanceType<typeof NoteList> | null>(null)

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

async function onNavClick(id: string): Promise<void> {
  activeView.value = id
  if (id === 'notes' && !activeNoteId.value) {
    await openFirstOrNewNote()
  }
}

function onNoteSelect(id: string): void {
  if (id === '') {
    activeNoteId.value = null
  } else {
    activeNoteId.value = id
  }
}

function onNoteSaved(): void {
  noteListRef.value?.refresh()
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="sidebar-top" />

      <nav class="sidebar-nav">
        <button
          v-for="item in navItems"
          :key="item.id"
          class="nav-item"
          :class="{ active: activeView === item.id }"
          @click="onNavClick(item.id)"
        >
          <span class="nav-icon">{{ item.icon }}</span>
          <span class="nav-label">{{ item.label }}</span>
        </button>
      </nav>

      <div class="sidebar-bottom">
        <button class="nav-item">
          <span class="nav-icon">⚙</span>
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
          />
          <div v-else class="placeholder">
            <span class="placeholder-icon">📝</span>
            <h2>Notes</h2>
            <button class="btn-primary" @click="newNote">New Note</button>
          </div>
        </div>
      </template>

      <!-- All other views -->
      <template v-else>
        <div class="placeholder">
          <span class="placeholder-icon">{{ navItems.find(n => n.id === activeView)?.icon }}</span>
          <h2>{{ navItems.find(n => n.id === activeView)?.label }}</h2>
          <p>Coming soon.</p>
        </div>
      </template>
    </main>
  </div>
</template>
