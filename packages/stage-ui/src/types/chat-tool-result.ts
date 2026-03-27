import type { CommonContentPart } from '@xsai/shared-chat'

/**
 * Normalized MCP-style tool output (callTool content + optional structured fields).
 */
export interface NormalizedMcpContentPart extends Record<string, unknown> {
  type: string
  text?: string
}

export interface NormalizedChatToolResult {
  content: NormalizedMcpContentPart[]
  structuredContent?: Record<string, unknown>
  isError?: boolean
  raw: unknown
}

/**
 * Context passed to pluggable chat tool-result renderers.
 */
export interface ChatToolResultRendererContext {
  toolCallId: string
  /** xsAI / provider tool name, e.g. `mcp_call_tool`. */
  xsaiToolName?: string
  /** When `xsaiToolName` is `mcp_call_tool`, the MCP `server::tool` name from arguments. */
  mcpQualifiedToolName?: string
  normalized: NormalizedChatToolResult
}

export type ToolResultRaw = string | CommonContentPart[] | Record<string, unknown> | undefined | null
