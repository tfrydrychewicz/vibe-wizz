import { ref, computed } from 'vue'

export type OpenMode = 'default' | 'new-pane' | 'new-tab'

export interface ContentPane {
  id: string
  type: 'note' | 'entity'
  contentId: string
  typeId?: string
  title: string
  icon: string
  color?: string
}

export interface Tab {
  id: string
  panes: ContentPane[]
  activePaneId: string
}

let _counter = 0
function newId(): string {
  return `${Date.now()}-${++_counter}`
}

export const tabs = ref<Tab[]>([])
export const activeTabId = ref<string>('')

export const activeTab = computed((): Tab | null =>
  tabs.value.find((t) => t.id === activeTabId.value) ?? null
)

export const activePane = computed((): ContentPane | null => {
  const tab = activeTab.value
  if (!tab) return null
  return tab.panes.find((p) => p.id === tab.activePaneId) ?? null
})

export function openContent(
  type: 'note' | 'entity',
  contentId: string,
  title: string,
  mode: OpenMode,
  typeId?: string,
  icon = 'file-text',
  color?: string
): void {
  const pane: ContentPane = { id: newId(), type, contentId, title, typeId, icon, color }

  if (mode === 'new-tab' || tabs.value.length === 0) {
    const tab: Tab = { id: newId(), panes: [pane], activePaneId: pane.id }
    tabs.value.push(tab)
    activeTabId.value = tab.id
  } else if (mode === 'new-pane') {
    const tab = activeTab.value!
    tab.panes.push(pane)
    tab.activePaneId = pane.id
  } else {
    // Default: replace active pane's content
    const tab = activeTab.value!
    const idx = tab.panes.findIndex((p) => p.id === tab.activePaneId)
    if (idx >= 0) {
      tab.panes.splice(idx, 1, pane)
    } else {
      tab.panes.push(pane)
      tab.activePaneId = pane.id
    }
  }
}

export function setActiveTab(id: string): void {
  activeTabId.value = id
}

export function setActivePaneInTab(tabId: string, paneId: string): void {
  const tab = tabs.value.find((t) => t.id === tabId)
  if (tab) tab.activePaneId = paneId
}

export function closePane(tabId: string, paneId: string): void {
  const tab = tabs.value.find((t) => t.id === tabId)
  if (!tab) return
  const newPanes = tab.panes.filter((p) => p.id !== paneId)
  if (newPanes.length === 0) {
    closeTab(tabId)
    return
  }
  tab.panes = newPanes
  if (tab.activePaneId === paneId) {
    tab.activePaneId = newPanes[newPanes.length - 1].id
  }
}

export function closeTab(tabId: string): void {
  const idx = tabs.value.findIndex((t) => t.id === tabId)
  if (idx < 0) return
  tabs.value.splice(idx, 1)
  if (activeTabId.value === tabId) {
    activeTabId.value = tabs.value.length > 0 ? tabs.value[Math.max(0, idx - 1)].id : ''
  }
}

export function updatePaneTitle(contentId: string, title: string): void {
  for (const tab of tabs.value) {
    for (const pane of tab.panes) {
      if (pane.contentId === contentId) {
        pane.title = title
      }
    }
  }
}

export function closePanesForContent(contentId: string): void {
  const snapshot = [...tabs.value]
  for (const tab of snapshot) {
    const paneIds = tab.panes.filter((p) => p.contentId === contentId).map((p) => p.id)
    for (const paneId of paneIds) {
      closePane(tab.id, paneId)
    }
  }
}
