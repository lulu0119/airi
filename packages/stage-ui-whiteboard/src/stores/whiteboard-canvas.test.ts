import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { useWhiteboardCanvasStore } from './whiteboard-canvas'

describe('useWhiteboardCanvasStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
  })

  it('creates and lists canvases', () => {
    const store = useWhiteboardCanvasStore()
    const c = store.createCanvas('Test', 100, 80, '#fff')
    expect(c.name).toBe('Test')
    expect(store.listCanvases()).toHaveLength(1)
    expect(store.foregroundCanvasId).toBe(c.id)
  })

  it('adds and deletes paths', () => {
    const store = useWhiteboardCanvasStore()
    const c = store.createCanvas('A')
    const p = store.addPath(c.id, {
      d: 'M0 0 L10 10',
      stroke: '#000',
      strokeWidth: 2,
      fill: 'none',
      opacity: 1,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
    expect(p).toBeDefined()
    expect(store.listPaths(c.id)).toHaveLength(1)
    expect(store.deletePath(c.id, p!.id)).toBe(true)
    expect(store.listPaths(c.id)).toHaveLength(0)
  })
})
