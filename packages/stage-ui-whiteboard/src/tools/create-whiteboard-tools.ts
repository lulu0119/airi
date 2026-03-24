import type { Tool } from '@xsai/shared-chat'

import type { WhiteboardCanvasStore } from './whiteboard-store-type'

import { tool } from '@xsai/tool'

import * as v from 'valibot'

import { FONT_PRESETS } from '../font-presets'
import { renderTextToPathData } from '../font-service'

/**
 * Phase 1: no `view_canvas_image` — pushing multimodal user messages inside `tool.execute` breaks strict
 * assistant → tool → ordering on some providers. See [xsai#274](https://github.com/moeru-ai/xsai/issues/274).
 * When upstream adds `prepareStep`, re-add vision tool and wire through `streamFrom`.
 */
export async function createWhiteboardTools(store: WhiteboardCanvasStore): Promise<Tool[]> {
  const createCanvas = await tool({
    name: 'create_canvas',
    description:
      'Create a new canvas with a given name, width, and height. If a canvas already exists for the task (use list_canvases), prefer editing it unless the user asked for a new one.',
    parameters: v.object({
      name: v.pipe(v.string(), v.description('Canvas name')),
      width: v.pipe(v.optional(v.number(), 800), v.description('Canvas width in pixels')),
      height: v.pipe(v.optional(v.number(), 600), v.description('Canvas height in pixels')),
      backgroundColor: v.pipe(v.optional(v.string(), '#ffffff'), v.description('Background color')),
    }),
    execute: ({ name, width, height, backgroundColor }) => {
      const c = store.createCanvas(name, width, height, backgroundColor)
      return JSON.stringify({ id: c.id, name: c.name, width: c.width, height: c.height })
    },
  })

  const deleteCanvasTool = await tool({
    name: 'delete_canvas',
    description: 'Delete a canvas by its ID.',
    parameters: v.object({
      canvasId: v.pipe(v.string(), v.description('The ID of the canvas to delete')),
    }),
    execute: ({ canvasId }) => {
      const ok = store.deleteCanvas(canvasId)
      return JSON.stringify({ success: ok })
    },
  })

  const viewCanvas = await tool({
    name: 'view_canvas',
    description:
      'Get the SVG string representation of a canvas, useful for seeing what is drawn. For complex edits or multi-path work, inspect before changing.',
    parameters: v.object({
      canvasId: v.pipe(v.string(), v.description('The ID of the canvas to view')),
    }),
    execute: ({ canvasId }) => {
      const canvas = store.getCanvas(canvasId)
      if (!canvas)
        return JSON.stringify({ error: 'Canvas not found' })
      const svg = store.toSVGString(canvasId)
      return JSON.stringify({
        id: canvas.id,
        name: canvas.name,
        width: canvas.width,
        height: canvas.height,
        pathCount: canvas.paths.length,
        svg,
      })
    },
  })

  const addPath = await tool({
    name: 'add_path',
    description:
      'Add an SVG path to a canvas. Use standard SVG path data (d attribute). Prefer calling view_canvas first when the composition is complex.',
    parameters: v.object({
      canvasId: v.pipe(v.string(), v.description('The ID of the canvas')),
      d: v.pipe(v.string(), v.description('SVG path data string (d attribute)')),
      stroke: v.pipe(v.optional(v.string(), '#000000'), v.description('Stroke color')),
      strokeWidth: v.pipe(v.optional(v.number(), 2), v.description('Stroke width')),
      fill: v.pipe(v.optional(v.string(), 'none'), v.description('Fill color')),
      opacity: v.pipe(v.optional(v.number(), 1), v.description('Opacity 0-1')),
    }),
    execute: ({ canvasId, d, stroke, strokeWidth, fill, opacity }) => {
      const p = store.addPath(canvasId, {
        d,
        stroke: stroke ?? '#000000',
        strokeWidth: strokeWidth ?? 2,
        fill: fill ?? 'none',
        opacity: opacity ?? 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      })
      if (!p)
        return JSON.stringify({ error: 'Canvas not found' })
      return JSON.stringify({ id: p.id, d: p.d })
    },
  })

  const deletePath = await tool({
    name: 'delete_path',
    description: 'Delete a path from a canvas by path ID.',
    parameters: v.object({
      canvasId: v.pipe(v.string(), v.description('The ID of the canvas')),
      pathId: v.pipe(v.string(), v.description('The ID of the path to delete')),
    }),
    execute: ({ canvasId, pathId }) => {
      const ok = store.deletePath(canvasId, pathId)
      return JSON.stringify({ success: ok })
    },
  })

  const listPathsTool = await tool({
    name: 'list_paths',
    description: 'List all paths on a canvas with their IDs and data.',
    parameters: v.object({
      canvasId: v.pipe(v.string(), v.description('The ID of the canvas')),
    }),
    execute: ({ canvasId }) => {
      const paths = store.listPaths(canvasId)
      return JSON.stringify(paths.map(p => ({ id: p.id, d: p.d, stroke: p.stroke, fill: p.fill })))
    },
  })

  const listCanvasesTool = await tool({
    name: 'list_canvases',
    description: 'List all canvases with their IDs, names, sizes, and which one is the foreground canvas.',
    parameters: v.object({}),
    execute: () => {
      const all = store.listCanvases()
      const fg = store.foregroundCanvasId
      return JSON.stringify(all.map(c => ({
        id: c.id,
        name: c.name,
        width: c.width,
        height: c.height,
        pathCount: c.paths.length,
        isForeground: c.id === fg,
      })))
    },
  })

  const listFontsTool = await tool({
    name: 'list_fonts',
    description: 'List all available fonts that can be used with render_text.',
    parameters: v.object({}),
    execute: () => {
      return JSON.stringify(FONT_PRESETS.map(f => ({ name: f.name, displayName: f.displayName, category: f.category })))
    },
  })

  const renderTextTool = await tool({
    name: 'render_text',
    description:
      'Render text into SVG paths using a real font. Each character becomes a separate path on the canvas. Use this instead of manually drawing letters with add_path.',
    parameters: v.object({
      canvasId: v.pipe(v.string(), v.description('The ID of the canvas')),
      text: v.pipe(v.string(), v.description('The text to render')),
      fontName: v.pipe(v.optional(v.string(), 'noto-sans-sc'), v.description('Font name from list_fonts')),
      fontSize: v.pipe(v.optional(v.number(), 48), v.description('Font size in pixels')),
      x: v.pipe(v.optional(v.number(), 50), v.description('X position of the text baseline start')),
      y: v.pipe(v.optional(v.number(), 100), v.description('Y position of the text baseline')),
      fill: v.pipe(v.optional(v.string(), '#000000'), v.description('Fill color')),
      stroke: v.pipe(v.optional(v.string(), 'none'), v.description('Stroke color')),
      strokeWidth: v.pipe(v.optional(v.number(), 0), v.description('Stroke width')),
      opacity: v.pipe(v.optional(v.number(), 1), v.description('Opacity 0-1')),
    }),
    execute: async ({ canvasId, text, fontName, fontSize, x, y, fill, stroke, strokeWidth, opacity }) => {
      const canvas = store.getCanvas(canvasId)
      if (!canvas)
        return JSON.stringify({ error: 'Canvas not found' })

      try {
        const result = await renderTextToPathData({
          text,
          fontName: fontName ?? 'noto-sans-sc',
          fontSize: fontSize ?? 48,
          x: x ?? 50,
          y: y ?? 100,
        })

        const pathIds: string[] = []
        for (const glyph of result.glyphs) {
          const p = store.addPath(canvasId, {
            d: glyph.d,
            fill: fill ?? '#000000',
            stroke: stroke ?? 'none',
            strokeWidth: strokeWidth ?? 0,
            opacity: opacity ?? 1,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })
          if (p)
            pathIds.push(p.id)
        }

        return JSON.stringify({
          pathIds,
          text,
          fontName: fontName ?? 'noto-sans-sc',
          fontSize: fontSize ?? 48,
          characterCount: result.glyphs.length,
          boundingBox: result.boundingBox,
        })
      }
      catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        return JSON.stringify({ error: msg })
      }
    },
  })

  return [
    createCanvas,
    deleteCanvasTool,
    viewCanvas,
    addPath,
    deletePath,
    listPathsTool,
    listCanvasesTool,
    listFontsTool,
    renderTextTool,
  ]
}
