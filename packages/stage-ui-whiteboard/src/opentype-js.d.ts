declare module 'opentype.js' {
  export interface Glyph {
    name?: string
    getPath: (x: number, y: number, fontSize: number) => Path
  }

  export interface Path {
    toPathData: (decimalPlaces?: number) => string
    getBoundingBox: () => { x1: number, y1: number, x2: number, y2: number }
  }

  export interface Font {
    forEachGlyph: (
      text: string,
      x: number,
      y: number,
      fontSize: number,
      options: Record<string, unknown>,
      callback: (glyph: Glyph, gx: number, gy: number, gFontSize: number) => void,
    ) => void
  }

  export function parse(buffer: ArrayBuffer): Font

  const opentype: { parse: typeof parse }
  export default opentype
}
