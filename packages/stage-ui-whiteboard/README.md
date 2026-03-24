# @proj-airi/stage-ui-whiteboard

Shared SVG whiteboard for AIRI Stage: Pinia canvas state, xsai tools (`create_canvas`, `add_path`, `render_text`, …), and a simple viewer page.

## Status

**Only [stage-web](https://github.com/moeru-ai/airi/tree/main/apps/stage-web) is adapted in a preliminary way** (tool registration, embedded dialog in layout). **stage-tamagotchi** and **stage-pocket** are not fully wired or polished yet (no parity with the web flow).

## Phases (integration plan)

Aligned with the whiteboard integration plan and [xsai#274](https://github.com/moeru-ai/xsai/issues/274):

- **Phase 1 (shippable):** Do not rely on `prepareStep`. Omit **`view_canvas_image`** (or keep vision out of `tool.execute` paths that push extra `user` messages) so providers that enforce strict tool → result ordering do not error. Tools today: `create_canvas`, `delete_canvas`, `view_canvas`, `add_path`, … — see package exports.
- **Phase 2:** When xsai exposes **`prepareStep`**, plumb it through [`packages/stage-ui/src/stores/llm.ts`](../stage-ui/src/stores/llm.ts) `streamFrom` → `streamText`, then restore a **`view_canvas_image`**-style vision tool (buffer multimodal user content until after tool messages, same idea as the original airi-whiteboard flow).

## Todo

- [x] Scaffold `packages/stage-ui-whiteboard` (exports, tsconfig, peers: vue / pinia / `@xsai/tool`, opentype.js).
- [x] Migrate Pinia canvas store, font presets / service, `createWhiteboardTools` (Phase 1: no `view_canvas_image`).
- [x] Register tools via [`whiteboard-tools-registry`](../stage-ui/src/stores/chat/whiteboard-tools-registry.ts) merged into chat `streamText` (with MCP + debug).
- [x] **stage-web — preliminary:** `setupStageUiWhiteboard()` in `main.ts`, embedded dialog in layout.
- [ ] **stage-tamagotchi:** Full route UX, controls-island (or equivalent) entry, window/layout parity with web.
- [ ] **stage-pocket:** End-to-end integration beyond ad-hoc dialog usage.
- [ ] **Phase 2:** Track xsai#274; pass through upstream options in `streamFrom` and reintroduce `view_canvas_image` / vision loop.

## Vision / `view_canvas_image`

Pushing multimodal `user` messages from inside `tool.execute` breaks strict message ordering on some providers ([xsai#274](https://github.com/moeru-ai/xsai/issues/274)). Phase 1 omits `view_canvas_image`. When xsai adds `prepareStep` (or equivalent), wire it through `streamFrom` → `streamText`, then restore the vision tool using `store.toImageDataURL`.

## Usage

```ts
import { setupStageUiWhiteboard } from '@proj-airi/stage-ui-whiteboard/register'

setupStageUiWhiteboard() // after pinia is installed
```

Embed `WhiteboardDialog.vue` in the stage layout, or mount `WhiteboardPage.vue` on an app-defined route when needed.
