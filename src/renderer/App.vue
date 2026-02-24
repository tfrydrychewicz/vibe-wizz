<script setup lang="ts">
import { ref } from 'vue'
import NoteEditor from './components/NoteEditor.vue'

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

async function newNote(): Promise<void> {
  const note = (await window.api.invoke('notes:create')) as { id: string }
  activeNoteId.value = note.id
}

function onNavClick(id: string): void {
  activeView.value = id
  if (id === 'notes' && !activeNoteId.value) {
    newNote()
  }
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
        <div v-if="activeNoteId" class="note-view">
          <div class="note-toolbar">
            <button class="toolbar-btn" @click="newNote">+ New Note</button>
          </div>
          <NoteEditor :note-id="activeNoteId" />
        </div>
        <div v-else class="placeholder">
          <span class="placeholder-icon">📝</span>
          <h2>Notes</h2>
          <button class="btn-primary" @click="newNote">New Note</button>
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
