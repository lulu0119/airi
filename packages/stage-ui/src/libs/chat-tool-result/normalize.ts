import type { NormalizedChatToolResult, NormalizedMcpContentPart, ToolResultRaw } from '../../types/chat-tool-result'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeParsedObject(o: Record<string, unknown>, raw: unknown): NormalizedChatToolResult {
  const content = Array.isArray(o.content)
    ? (o.content as NormalizedMcpContentPart[])
    : []
  const structuredContent = isRecord(o.structuredContent) ? o.structuredContent : undefined
  const isError = typeof o.isError === 'boolean' ? o.isError : undefined
  return { content, structuredContent, isError, raw }
}

/**
 * Turn streamed tool `result` (string, parts[], or JSON object) into MCP-like shape for UI renderers.
 */
export function normalizeToolResult(raw: ToolResultRaw): NormalizedChatToolResult {
  if (raw == null) {
    return { content: [], raw }
  }

  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (isRecord(parsed)) {
          return normalizeParsedObject(parsed, parsed)
        }
      }
      catch {
        // fall through to plain text
      }
    }
    return { content: [{ type: 'text', text: raw }], raw }
  }

  if (Array.isArray(raw)) {
    return { content: raw as NormalizedMcpContentPart[], raw }
  }

  if (isRecord(raw)) {
    return normalizeParsedObject(raw, raw)
  }

  return { content: [{ type: 'text', text: String(raw) }], raw }
}

export function joinTextParts(content: NormalizedMcpContentPart[]): string {
  return content
    .filter(part => part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('\n')
}
