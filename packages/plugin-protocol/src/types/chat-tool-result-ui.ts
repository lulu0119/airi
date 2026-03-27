/**
 * Declarative shape for modules that contribute chat tool-result renderers (Phase 2: manifest → host loads bundle).
 * Phase 1: call `registerChatToolResultRenderer` from `@proj-airi/stage-ui` at app/plugin init.
 */

/** How the host matches a tool result to a renderer. */
export interface ChatToolResultRendererMatchDescriptor {
  /** Match xsAI-level tool name, e.g. `mcp_call_tool`. */
  xsaiToolName?: string
  /** Match MCP qualified name from `mcp_call_tool` args, e.g. `excalidraw::create_view`. */
  mcpQualifiedToolNamePrefix?: string
  mcpQualifiedToolNameSuffix?: string
  /** If true, require JSON/text body to include this substring (cheap guard). */
  textIncludes?: string
}

/**
 * Serialized contribution (e.g. under `ModuleContribution.hooks` or `ModuleContribution.ui`).
 */
export interface ChatToolResultRendererContribution {
  type: 'chat.tool-result-renderer'
  /** Unique per renderer; host may dedupe on this id. */
  id: string
  priority: number
  /** Entry module URL or path resolved by the host (implementation-specific). */
  entry?: string
  match: ChatToolResultRendererMatchDescriptor
}
