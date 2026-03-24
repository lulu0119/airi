import { registerWhiteboardToolsProvider } from '@proj-airi/stage-ui/stores/chat/whiteboard-tools-registry'

import { useWhiteboardCanvasStore } from './stores/whiteboard-canvas'
import { createWhiteboardTools } from './tools/create-whiteboard-tools'

/**
 * Register whiteboard xsai tools for every chat completion. Call once after `app.use(pinia)`.
 * @returns unregister function
 */
export function setupStageUiWhiteboard(): () => void {
  return registerWhiteboardToolsProvider(async () => {
    const store = useWhiteboardCanvasStore()
    return createWhiteboardTools(store)
  })
}
