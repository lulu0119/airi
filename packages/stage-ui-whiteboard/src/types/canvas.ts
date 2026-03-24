export interface CanvasPath {
  id: string
  d: string
  stroke: string
  strokeWidth: number
  fill: string
  opacity: number
  strokeLinecap: 'round' | 'butt' | 'square'
  strokeLinejoin: 'round' | 'miter' | 'bevel'
}

export interface Canvas {
  id: string
  name: string
  width: number
  height: number
  backgroundColor: string
  paths: CanvasPath[]
  createdAt: number
}
