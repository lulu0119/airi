# @proj-airi/mcp-surface-contract

Shared **proj-airi Surface** envelope for MCP `CallToolResult.structuredContent`: a small JSON object so AIRI (and other hosts) can render tool output without per-server UI adapters.

## Placement

Set on the tool result’s `structuredContent` under the key **`projAiriSurface`** (see `PROJ_AIRI_SURFACE_KEY`).

## v1

- **`version`**: `1`
- **`kind`**: `"embedUrl"` (only kind supported by AIRI host v1)
- **`data.url`**: `http:` or `https:` URL loaded in a **sandbox iframe**
- **`data.mimeType`**: optional hint (e.g. `text/html`)
- **`title` / `summary`**: optional strings for UI copy

JSON Schema: `schema/proj-airi-surface-v1.json`.

## Usage (TypeScript)

```ts
import { parseProjAiriSurfaceV1, PROJ_AIRI_SURFACE_KEY } from '@proj-airi/mcp-surface-contract'

const surface = parseProjAiriSurfaceV1(structuredContent)
```

## MCP servers

Implementing servers should attach `projAiriSurface` whenever the model should show a web surface in chat (exported share links, local preview pages, Slidev dev URLs, etc.).
