import type { ContextMessage } from '../../../types/chat'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

const INTERRUPT_CONTEXT_ID = 'system:user-interrupted-assistant'

/**
 * Injected after a user interrupt so the model knows the prior assistant turn was incomplete.
 */
export function createUserInterruptedAssistantContext(): ContextMessage {
  return {
    id: nanoid(),
    contextId: INTERRUPT_CONTEXT_ID,
    strategy: ContextUpdateStrategy.AppendSelf,
    text: 'The user interrupted the assistant before the reply finished. Treat the last assistant message as incomplete.',
    createdAt: Date.now(),
    metadata: {
      source: {
        id: INTERRUPT_CONTEXT_ID,
        kind: 'plugin',
        plugin: {
          id: 'airi:chat:user-interrupt',
        },
      },
    },
  }
}
