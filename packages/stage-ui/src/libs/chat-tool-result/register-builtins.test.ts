import { afterEach, describe, expect, it } from 'vitest'

import { clearChatToolResultRenderersForTests, resolveChatToolResultRenderer } from '../../stores/chat-tool-result-registry'
import { normalizeToolResult } from './normalize'
import { registerBuiltInChatToolResultRenderers } from './register-builtins'

describe('registerBuiltInChatToolResultRenderers', () => {
  afterEach(() => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()
  })

  it('matches excalidraw.com json share URL in text content', () => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()

    const url = 'https://excalidraw.com/#json=abc,key'
    const ctx = {
      toolCallId: 't1',
      mcpQualifiedToolName: 'excalidraw::export_to_excalidraw',
      normalized: normalizeToolResult({
        content: [{ type: 'text', text: `Done.\n${url}` }],
      }),
    }
    expect(resolveChatToolResultRenderer(ctx)?.id).toBe('excalidraw-json-url')
  })

  it('matches create_view checkpoint notice', () => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()

    const ctx = {
      toolCallId: 't2',
      mcpQualifiedToolName: 'excalidraw::create_view',
      normalized: normalizeToolResult({
        content: [{ type: 'text', text: 'Diagram displayed! Checkpoint id: "x".' }],
        structuredContent: { checkpointId: 'chk1' },
      }),
    }
    expect(resolveChatToolResultRenderer(ctx)?.id).toBe('excalidraw-create-view-notice')
  })
})
