/**
 * Key under MCP CallToolResult.structuredContent that holds the proj-airi Surface envelope.
 */
export const PROJ_AIRI_SURFACE_KEY = 'projAiriSurface' as const

/** v1 host only implements this kind (URL + iframe in AIRI). */
export type ProjAiriSurfaceKindV1 = 'embedUrl'

export interface ProjAiriSurfaceEmbedUrlDataV1 {
  url: string
  mimeType?: string
}

export interface ProjAiriSurfaceV1 {
  version: 1
  kind: ProjAiriSurfaceKindV1
  title?: string
  summary?: string
  data: ProjAiriSurfaceEmbedUrlDataV1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Allows http(s) URLs for sandbox iframe embedding. Rejects opaque or dangerous schemes.
 */
export function isSafeEmbedUrlForIframe(urlString: string): boolean {
  try {
    const u = new URL(urlString)
    return u.protocol === 'http:' || u.protocol === 'https:'
  }
  catch {
    return false
  }
}

/**
 * Extract and validate proj-airi Surface v1 (embedUrl) from MCP structuredContent.
 */
export function parseProjAiriSurfaceV1(
  structuredContent: Record<string, unknown> | undefined,
): ProjAiriSurfaceV1 | undefined {
  if (!structuredContent)
    return undefined
  const raw = structuredContent[PROJ_AIRI_SURFACE_KEY]
  if (!isRecord(raw))
    return undefined
  if (raw.version !== 1)
    return undefined
  if (raw.kind !== 'embedUrl')
    return undefined
  const data = raw.data
  if (!isRecord(data))
    return undefined
  const url = data.url
  if (typeof url !== 'string' || !url.trim())
    return undefined
  if (!isSafeEmbedUrlForIframe(url.trim()))
    return undefined
  const mimeType = data.mimeType
  if (mimeType !== undefined && typeof mimeType !== 'string')
    return undefined
  const title = raw.title
  if (title !== undefined && typeof title !== 'string')
    return undefined
  const summary = raw.summary
  if (summary !== undefined && typeof summary !== 'string')
    return undefined

  return {
    version: 1,
    kind: 'embedUrl',
    title: typeof title === 'string' ? title : undefined,
    summary: typeof summary === 'string' ? summary : undefined,
    data: {
      url: url.trim(),
      mimeType: typeof mimeType === 'string' ? mimeType : undefined,
    },
  }
}
