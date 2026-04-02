import type { ChatToolResultRendererContext } from '../../types/chat-tool-result'

import { parseProjAiriSurfaceV1 } from '@proj-airi/mcp-surface-contract'

import ChatToolResultProjAiriSurface from '../../components/scenarios/chat/chat-tool-result-proj-airi-surface.vue'

import { registerChatToolResultRenderer } from '../../stores/chat-tool-result-registry'

function matchProjAiriSurfaceEmbedUrl(ctx: ChatToolResultRendererContext): boolean {
  const s = parseProjAiriSurfaceV1(ctx.normalized.structuredContent)
  return s !== undefined && !ctx.normalized.isError
}

/**
 * Registers default chat tool-result renderers (proj-airi Surface embedUrl).
 * Uses stable ids so repeat calls replace the same entries (see `registerChatToolResultRenderer`).
 */
export function registerBuiltInChatToolResultRenderers(): void {
  registerChatToolResultRenderer({
    id: 'proj-airi-surface-embed-url',
    priority: 60,
    match: ctx => matchProjAiriSurfaceEmbedUrl(ctx),
    component: ChatToolResultProjAiriSurface,
  })
}
