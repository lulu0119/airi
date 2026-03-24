import type { Font } from 'opentype.js'

import opentype from 'opentype.js'

import { FONT_PRESET_MAP } from './font-presets'

const fontCache = new Map<string, Font>()
const loadingPromises = new Map<string, Promise<Font>>()

export async function loadFont(fontName: string): Promise<Font> {
  const cached = fontCache.get(fontName)
  if (cached)
    return cached

  const existing = loadingPromises.get(fontName)
  if (existing)
    return existing

  const preset = FONT_PRESET_MAP.get(fontName)
  if (!preset)
    throw new Error(`Unknown font: ${fontName}`)

  const promise = fetch(preset.url)
    .then((res) => {
      if (!res.ok)
        throw new Error(`Failed to fetch font ${fontName}: ${res.status}`)
      return res.arrayBuffer()
    })
    .then((buffer) => {
      const font = opentype.parse(buffer)
      fontCache.set(fontName, font)
      loadingPromises.delete(fontName)
      return font
    })
    .catch((err) => {
      loadingPromises.delete(fontName)
      throw err
    })

  loadingPromises.set(fontName, promise)
  return promise
}

export interface GlyphResult {
  d: string
  char: string
  boundingBox: { x1: number, y1: number, x2: number, y2: number }
}

export interface RenderTextResult {
  glyphs: GlyphResult[]
  boundingBox: { x1: number, y1: number, x2: number, y2: number }
}

export async function renderTextToPathData(options: {
  text: string
  fontName: string
  fontSize: number
  x: number
  y: number
}): Promise<RenderTextResult> {
  const { text, fontName, fontSize, x, y } = options
  const font = await loadFont(fontName)

  const glyphs: GlyphResult[] = []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  font.forEachGlyph(text, x, y, fontSize, {}, (glyph, gx, gy, gFontSize) => {
    const path = glyph.getPath(gx, gy, gFontSize)
    const d = path.toPathData(2)
    if (!d)
      return

    const bb = path.getBoundingBox()
    glyphs.push({
      d,
      char: glyph.name || '',
      boundingBox: { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2 },
    })

    minX = Math.min(minX, bb.x1)
    minY = Math.min(minY, bb.y1)
    maxX = Math.max(maxX, bb.x2)
    maxY = Math.max(maxY, bb.y2)
  })

  return {
    glyphs,
    boundingBox: {
      x1: glyphs.length ? minX : x,
      y1: glyphs.length ? minY : y,
      x2: glyphs.length ? maxX : x,
      y2: glyphs.length ? maxY : y,
    },
  }
}
