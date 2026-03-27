import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'

import { normalizeToolResult } from '../libs/chat-tool-result/normalize'
import { registerBuiltInChatToolResultRenderers } from '../libs/chat-tool-result/register-builtins'
import {
  clearChatToolResultRenderersForTests,
  registerChatToolResultRenderer,
  resolveChatToolResultRenderer,
} from './chat-tool-result-registry'

const Dummy = defineComponent({
  name: 'DummyToolResultRenderer',
  props: { ctx: { type: Object, required: true } },
  render() {
    return h('div')
  },
})

describe('chat-tool-result-registry', () => {
  afterEach(() => {
    clearChatToolResultRenderersForTests()
    registerBuiltInChatToolResultRenderers()
  })

  it('picks higher priority first', () => {
    clearChatToolResultRenderersForTests()

    registerChatToolResultRenderer({
      id: 'low',
      priority: 1,
      match: () => true,
      component: Dummy,
    })
    registerChatToolResultRenderer({
      id: 'high',
      priority: 10,
      match: () => true,
      component: Dummy,
    })

    const ctx = {
      toolCallId: '1',
      normalized: normalizeToolResult({ content: [] }),
    }
    expect(resolveChatToolResultRenderer(ctx)?.id).toBe('high')
  })

  it('replaces same id on re-register', () => {
    clearChatToolResultRenderersForTests()

    registerChatToolResultRenderer({
      id: 'same',
      priority: 5,
      match: () => false,
      component: Dummy,
    })
    registerChatToolResultRenderer({
      id: 'same',
      priority: 5,
      match: () => true,
      component: Dummy,
    })

    const ctx = {
      toolCallId: '1',
      normalized: normalizeToolResult({ content: [] }),
    }
    expect(resolveChatToolResultRenderer(ctx)?.id).toBe('same')
  })
})
