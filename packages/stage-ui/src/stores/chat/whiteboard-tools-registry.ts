import type { Tool } from '@xsai/shared-chat'

const providers: Array<() => Promise<Tool[]>> = []

/**
 * Register whiteboard xsai tools merged into every `streamText` call (after MCP + debug, before per-request `options.tools`).
 * Call from app bootstrap after Pinia is installed. Returns an unregister function.
 */
export function registerWhiteboardToolsProvider(provider: () => Promise<Tool[]>): () => void {
  providers.push(provider)
  return () => {
    const i = providers.indexOf(provider)
    if (i >= 0)
      providers.splice(i, 1)
  }
}

export async function getWhiteboardTools(): Promise<Tool[]> {
  const parts = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p()
      }
      catch (err) {
        console.warn('[whiteboard-tools] provider failed:', err)
        return []
      }
    }),
  )
  return parts.flat()
}
