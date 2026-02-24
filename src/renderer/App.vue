<script setup lang="ts">
import { ref } from 'vue'

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
          @click="activeView = item.id"
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
      <div class="placeholder">
        <span class="placeholder-icon">{{ navItems.find(n => n.id === activeView)?.icon }}</span>
        <h2>{{ navItems.find(n => n.id === activeView)?.label }}</h2>
        <p>Coming soon.</p>
      </div>
    </main>
  </div>
</template>
