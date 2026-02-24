<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { Search, FileText } from 'lucide-vue-next'
import type { OpenMode } from '../stores/tabStore'

const emit = defineEmits<{
  'open-note': [{ noteId: string; title: string; mode: OpenMode }]
}>()

interface SearchResult {
  id: string
  title: string
  excerpt: string | null
}

const query = ref('')
const results = ref<SearchResult[]>([])
const searching = ref(false)
const hasSearched = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)

/** true once the user has typed anything — triggers the slide-to-top transition */
const isActive = computed(() => query.value.trim().length > 0)

let debounceTimer: ReturnType<typeof setTimeout> | null = null

watch(query, (val) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!val.trim()) {
    results.value = []
    hasSearched.value = false
    searching.value = false
    return
  }
  searching.value = true
  debounceTimer = setTimeout(() => runSearch(val.trim()), 300)
})

async function runSearch(q: string): Promise<void> {
  try {
    const res = (await window.api.invoke('notes:semantic-search', { query: q })) as SearchResult[]
    results.value = res
    hasSearched.value = true
  } catch {
    results.value = []
    hasSearched.value = true
  } finally {
    searching.value = false
  }
}

function openNote(e: MouseEvent, result: SearchResult): void {
  const mode: OpenMode = (e.metaKey || e.ctrlKey) ? 'new-tab' : e.shiftKey ? 'new-pane' : 'default'
  emit('open-note', { noteId: result.id, title: result.title, mode })
}

function truncate(text: string, max = 200): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf(' ', max)
  return (cut > 0 ? text.slice(0, cut) : text.slice(0, max)) + '…'
}

onMounted(() => {
  inputRef.value?.focus()
})
</script>

<template>
  <div class="search-view" :class="{ 'is-active': isActive }">

    <!-- Search bar — vertically centered when idle, slides to top on first keystroke -->
    <div class="search-header">
      <div class="search-box">
        <Search class="search-icon" :size="15" />
        <input
          ref="inputRef"
          v-model="query"
          class="search-input"
          type="text"
          placeholder="Search notes…"
          autocomplete="off"
          spellcheck="false"
        />
        <span v-if="searching" class="search-spinner" />
      </div>
    </div>

    <!-- Results — invisible / empty in idle state -->
    <div class="search-body">
      <div v-if="results.length > 0" class="results-list">
        <button
          v-for="result in results"
          :key="result.id"
          class="result-item"
          @click="openNote($event, result)"
        >
          <span class="result-icon"><FileText :size="14" /></span>
          <div class="result-content">
            <span class="result-title">{{ result.title || 'Untitled' }}</span>
            <span v-if="result.excerpt" class="result-excerpt">{{ truncate(result.excerpt) }}</span>
          </div>
        </button>
      </div>

      <div v-else-if="hasSearched && !searching" class="empty-state">
        <span class="empty-icon"><Search :size="22" /></span>
        <p>No notes found for <strong>{{ query }}</strong></p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  align-self: stretch;
  overflow: hidden;
}

/* ── Header: centred when idle, pinned to top once user types ── */

.search-header {
  flex-shrink: 0;
  /* push the bar to ~40% from the top in idle mode */
  padding-top: calc(40vh - 40px);
  transition: padding-top 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.is-active .search-header {
  padding-top: 20px;
}

.search-box {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 48px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  transition: border-bottom-color 0.15s;
}

.search-box:focus-within {
  border-bottom-color: var(--color-accent);
}

.search-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--color-text);
  font-size: 15px;
  font-family: inherit;
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.search-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Results body ── */

.search-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0;
}

.results-list {
  display: flex;
  flex-direction: column;
}

.result-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 64px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
  transition: background 0.1s;
  width: 100%;
}

.result-item:hover {
  background: var(--color-hover);
}

.result-icon {
  color: var(--color-text-muted);
  flex-shrink: 0;
  margin-top: 2px;
}

.result-content {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.result-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.result-excerpt {
  font-size: 12px;
  color: var(--color-text-muted);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 40px 24px;
  color: var(--color-text-muted);
}

.empty-icon {
  opacity: 0.3;
}

.empty-state p {
  font-size: 13px;
  margin: 0;
}

.empty-state strong {
  color: var(--color-text);
}
</style>
