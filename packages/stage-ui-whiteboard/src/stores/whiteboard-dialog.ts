import { defineStore } from 'pinia'
import { ref } from 'vue'

/** Controls Stage Web / mobile embedded whiteboard dialog visibility (not canvas data). */
export const useWhiteboardDialogStore = defineStore('whiteboard-dialog', () => {
  const dialogOpen = ref(true)

  function openDialog() {
    dialogOpen.value = true
  }

  function closeDialog() {
    dialogOpen.value = false
  }

  function toggleDialog() {
    dialogOpen.value = !dialogOpen.value
  }

  return {
    dialogOpen,
    openDialog,
    closeDialog,
    toggleDialog,
  }
})
