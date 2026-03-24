import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Controls Stage Web / mobile embedded whiteboard panel visibility (not canvas data). */
export const useWhiteboardPanelStore = defineStore('whiteboard-panel', () => {
  const panelOpen = ref(false)

  function openPanel() {
    panelOpen.value = true
  }

  function closePanel() {
    panelOpen.value = false
  }

  function togglePanel() {
    panelOpen.value = !panelOpen.value
  }

  return {
    panelOpen,
    openPanel,
    closePanel,
    togglePanel,
  }
})
