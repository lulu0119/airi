import type { ChatToolResultRendererContext } from '../../types/chat-tool-result'

import ChatToolResultExcalidrawDiagramNotice from '../../components/scenarios/chat/chat-tool-result-excalidraw-diagram-notice.vue'
import ChatToolResultExcalidrawUrl from '../../components/scenarios/chat/chat-tool-result-excalidraw-url.vue'

import { registerChatToolResultRenderer } from '../../stores/chat-tool-result-registry'
import { joinTextParts } from './normalize'

const EXCALIDRAW_JSON_URL = /https:\/\/excalidraw\.com\/#json=[^\s"'<>]+/i

function matchExcalidrawShareUrl(ctx: ChatToolResultRendererContext): boolean {
  const text = joinTextParts(ctx.normalized.content)
  return EXCALIDRAW_JSON_URL.test(text)
}

function matchExcalidrawCreateViewNotice(ctx: ChatToolResultRendererContext): boolean {
  const q = ctx.mcpQualifiedToolName
  if (!q?.includes('::create_view'))
    return false
  const cp = ctx.normalized.structuredContent?.checkpointId
  if (typeof cp !== 'string' || !cp.length)
    return false
  const text = joinTextParts(ctx.normalized.content)
  return text.includes('Diagram displayed!')
}

/**
 * Registers default chat tool-result renderers (Excalidraw URL iframe, diagram notice).
 * Uses stable ids so repeat calls replace the same entries (see `registerChatToolResultRenderer`).
 */
export function registerBuiltInChatToolResultRenderers(): void {
  registerChatToolResultRenderer({
    id: 'excalidraw-json-url',
    priority: 50,
    match: ctx => matchExcalidrawShareUrl(ctx) && !ctx.normalized.isError,
    component: ChatToolResultExcalidrawUrl,
  })

  registerChatToolResultRenderer({
    id: 'excalidraw-create-view-notice',
    priority: 25,
    match: ctx => matchExcalidrawCreateViewNotice(ctx) && !ctx.normalized.isError,
    component: ChatToolResultExcalidrawDiagramNotice,
  })
}
