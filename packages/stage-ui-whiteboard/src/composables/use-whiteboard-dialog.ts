import { storeToRefs } from 'pinia'

import { useWhiteboardDialogStore } from '../stores/whiteboard-dialog'

export function useWhiteboardDialog() {
  const store = useWhiteboardDialogStore()
  const { dialogOpen } = storeToRefs(store)
  const { openDialog, closeDialog, toggleDialog } = store
  return { dialogOpen, openDialog, closeDialog, toggleDialog }
}
