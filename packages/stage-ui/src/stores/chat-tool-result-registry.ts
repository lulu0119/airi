import type { Component } from 'vue'

import type { ChatToolResultRendererContext } from '../types/chat-tool-result'

export interface ChatToolResultRendererRegistration {
  /** Stable id for debugging and future unregister. */
  id: string
  /** Higher runs first. */
  priority: number
  match: (ctx: ChatToolResultRendererContext) => boolean
  component: Component
}

const registrations: ChatToolResultRendererRegistration[] = []

export function registerChatToolResultRenderer(entry: ChatToolResultRendererRegistration): () => void {
  const existing = registrations.findIndex(r => r.id === entry.id)
  if (existing !== -1)
    registrations.splice(existing, 1)
  registrations.push(entry)
  registrations.sort((a, b) => b.priority - a.priority)
  return () => {
    const i = registrations.indexOf(entry)
    if (i !== -1)
      registrations.splice(i, 1)
  }
}

export function clearChatToolResultRenderersForTests() {
  registrations.length = 0
}

export function listChatToolResultRenderers(): readonly ChatToolResultRendererRegistration[] {
  return registrations
}

export function resolveChatToolResultRenderer(ctx: ChatToolResultRendererContext): ChatToolResultRendererRegistration | undefined {
  return registrations.find(r => r.match(ctx))
}
