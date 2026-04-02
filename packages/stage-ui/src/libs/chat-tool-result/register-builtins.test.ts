import { afterEach, describe, expect, it } from 'vitest'

import { clearChatToolResultRenderersForTests, resolveChatToolResultRenderer } from '../../stores/chat-tool-result-registry'
import { normalizeToolResult } from './normalize'
import { registerBuiltInChatToolResultRenderers } from './register-builtins'

describe('registerBuiltInChatToolResultRenderers', () => {
  afterEach(() => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()
  })

  it('matches projAiriSurface embedUrl in structuredContent', () => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()

    const ctx = {
      toolCallId: 't1',
      mcpQualifiedToolName: 'demo::any_tool',
      normalized: normalizeToolResult({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: {
          projAiriSurface: {
            version: 1,
            kind: 'embedUrl',
            title: 'Preview',
            data: { url: 'https://example.com/embed' },
          },
        },
      }),
    }
    expect(resolveChatToolResultRenderer(ctx)?.id).toBe('proj-airi-surface-embed-url')
  })

  it('does not match non-http URL', () => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()

    const ctx = {
      toolCallId: 't2',
      normalized: normalizeToolResult({
        content: [{ type: 'text', text: 'x' }],
        structuredContent: {
          projAiriSurface: {
            version: 1,
            kind: 'embedUrl',
            data: { url: 'javascript:alert(1)' },
          },
        },
      }),
    }
    expect(resolveChatToolResultRenderer(ctx)).toBeUndefined()
  })
})
