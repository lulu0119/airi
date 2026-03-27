import type { CompletionToolCall } from '@xsai/shared-chat'

import type { ChatSlices, ChatSlicesToolCall } from '../../types/chat'

function toolCallCorrelationId(toolCall: CompletionToolCall): string | undefined {
  const extended = toolCall as CompletionToolCall & { id?: string }
  return extended.id ?? toolCall.toolCallId
}

export function resolveXsaiToolName(slices: ChatSlices[], toolCallId: string): string | undefined {
  for (const slice of slices) {
    if (slice.type === 'tool-call' && toolCallCorrelationId(slice.toolCall) === toolCallId) {
      return slice.toolCall.toolName
    }
  }
  return undefined
}

/**
 * For `mcp_call_tool`, parse `arguments` JSON and return MCP qualified name (`server::tool`).
 */
export function resolveMcpQualifiedToolName(slices: ChatSlices[], toolCallId: string): string | undefined {
  const slice = slices.find((s): s is ChatSlicesToolCall =>
    s.type === 'tool-call' && toolCallCorrelationId(s.toolCall) === toolCallId,
  )
  if (!slice || slice.toolCall.toolName !== 'mcp_call_tool')
    return undefined

  try {
    const args = JSON.parse(slice.toolCall.args) as { name?: string }
    return typeof args.name === 'string' ? args.name : undefined
  }
  catch {
    return undefined
  }
}
