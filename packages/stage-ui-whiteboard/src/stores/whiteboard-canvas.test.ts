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

  it('undoes and redoes add and delete', () => {
    const store = useWhiteboardCanvasStore()
    const c = store.createCanvas('B')
    const p = store.addPath(c.id, {
      d: 'M0 0',
      stroke: '#000',
      strokeWidth: 2,
      fill: 'none',
      opacity: 1,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
    expect(store.canUndo(c.id)).toBe(true)
    expect(store.undo(c.id)).toBe(true)
    expect(store.listPaths(c.id)).toHaveLength(0)
    expect(store.canRedo(c.id)).toBe(true)
    expect(store.redo(c.id)).toBe(true)
    expect(store.listPaths(c.id)).toHaveLength(1)
    expect(store.listPaths(c.id)[0]!.id).toBe(p!.id)

    expect(store.deletePath(c.id, p!.id)).toBe(true)
    expect(store.listPaths(c.id)).toHaveLength(0)
    expect(store.undo(c.id)).toBe(true)
    expect(store.listPaths(c.id)).toHaveLength(1)
    expect(store.redo(c.id)).toBe(true)
    expect(store.listPaths(c.id)).toHaveLength(0)
  })

  it('clears redo stack on new edit after undo', () => {
    const store = useWhiteboardCanvasStore()
    const c = store.createCanvas('C')
    store.addPath(c.id, {
      d: 'M1 1',
      stroke: '#000',
      strokeWidth: 2,
      fill: 'none',
      opacity: 1,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
    store.undo(c.id)
    expect(store.canRedo(c.id)).toBe(true)
    store.addPath(c.id, {
      d: 'M2 2',
      stroke: '#f00',
      strokeWidth: 2,
      fill: 'none',
      opacity: 1,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    })
    expect(store.canRedo(c.id)).toBe(false)
    expect(store.listPaths(c.id)).toHaveLength(1)
  })
})
