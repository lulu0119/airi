import type { Canvas, CanvasPath } from '../types/canvas'

/** Store shape used by whiteboard tools (Pinia `useWhiteboardCanvasStore` satisfies this). */
export interface WhiteboardCanvasStore {
  /** Current tab / default target for tools; Pinia unwraps the underlying ref. */
  foregroundCanvasId: string | null
  createCanvas: (name: string, width?: number, height?: number, backgroundColor?: string) => Canvas
  deleteCanvas: (id: string) => boolean
  getCanvas: (id: string) => Canvas | undefined
  listCanvases: () => Canvas[]
  addPath: (canvasId: string, pathData: Omit<CanvasPath, 'id'>) => CanvasPath | undefined
  deletePath: (canvasId: string, pathId: string) => boolean
  listPaths: (canvasId: string) => CanvasPath[]
  toSVGString: (canvasId: string) => string
}
