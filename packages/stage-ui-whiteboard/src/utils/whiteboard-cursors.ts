/** CSS `cursor: url(...)` from inline SVG — no extra DOM, no follow-the-mouse jank. */
export function wbDataSvgCursor(svg: string, hotspotX: number, hotspotY: number, fallback: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotspotX} ${hotspotY}, ${fallback}`
}

// Phosphor-style glyphs (MIT: https://github.com/phosphor-icons/core/blob/main/LICENSE). `#404040` reads on light boards; fallback covers edge cases.
export const WB_DRAW_CURSOR_CSS = wbDataSvgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256"><path fill="#404040" d="m230.14 70.54l-44.68-44.69a20 20 0 0 0-28.29 0L33.86 149.17A19.85 19.85 0 0 0 28 163.31V208a20 20 0 0 0 20 20h44.69a19.86 19.86 0 0 0 14.14-5.86L230.14 98.82a20 20 0 0 0 0-28.28M91 204H52v-39l84-84l39 39Zm101-101l-39-39l18.34-18.34l39 39Z"/></svg>',
  4,
  16,
  'crosshair',
)

export const WB_ERASE_CURSOR_CSS = wbDataSvgCursor(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 256 256"><path fill="#404040" d="M216 204h-75l86.84-86.84a28 28 0 0 0 0-39.6l-41.41-41.37a28 28 0 0 0-39.6 0L28.19 154.82a28 28 0 0 0 0 39.6l30.06 30.07a12 12 0 0 0 8.49 3.51H216a12 12 0 0 0 0-24M163.8 53.16a4 4 0 0 1 5.66 0l41.38 41.38a4 4 0 0 1 0 5.65L160 151l-47-47ZM71.71 204l-26.55-26.55a4 4 0 0 1 0-5.65L96 121l47 47l-36 36Z"/></svg>',
  6,
  16,
  'auto',
)
