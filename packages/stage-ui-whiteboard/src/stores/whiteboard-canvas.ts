import type { Canvas, CanvasPath } from '../types/canvas'

import { nanoid } from 'nanoid'
import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

const STORAGE_KEY = 'airi-whiteboard-canvases'
const FG_STORAGE_KEY = 'airi-whiteboard-foreground'
const MAX_HISTORY = 80

type HistoryEntry
  = | { kind: 'add', canvasId: string, path: CanvasPath }
    | { kind: 'delete', canvasId: string, path: CanvasPath }

const RE_XML_AMP = /&/g
const RE_XML_LT = /</g
const RE_XML_DQUOTE = /"/g
const RE_XML_SQUOTE = /'/g

function loadInitial(): { list: Canvas[], foregroundId: string | null } {
  if (typeof localStorage === 'undefined')
    return { list: [], foregroundId: null }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const list: Canvas[] = raw ? JSON.parse(raw) : []
    let foregroundId: string | null = null
    const fg = localStorage.getItem(FG_STORAGE_KEY)
    if (fg && list.some(c => c.id === fg))
      foregroundId = fg
    else if (list.length > 0)
      foregroundId = list[0]!.id
    return { list, foregroundId }
  }
  catch {
    return { list: [], foregroundId: null }
  }
}

function persistToStorage(canvases: Canvas[], foregroundId: string | null) {
  if (typeof localStorage === 'undefined')
    return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(canvases))
    if (foregroundId)
      localStorage.setItem(FG_STORAGE_KEY, foregroundId)
    else
      localStorage.removeItem(FG_STORAGE_KEY)
  }
  catch {
    // quota etc.
  }
}

function clonePath(p: CanvasPath): CanvasPath {
  return { ...p }
}

export const useWhiteboardCanvasStore = defineStore('whiteboard-canvas', () => {
  const initial = loadInitial()
  const canvases = ref<Canvas[]>(initial.list)
  const foregroundCanvasId = ref<string | null>(initial.foregroundId)

  /** Not persisted; lost on reload. */
  const historyByCanvas = reactive<Record<string, { past: HistoryEntry[], future: HistoryEntry[] }>>({})

  function stacksFor(canvasId: string) {
    if (!historyByCanvas[canvasId])
      historyByCanvas[canvasId] = { past: [], future: [] }
    return historyByCanvas[canvasId]!
  }

  function clearRedo(canvasId: string) {
    stacksFor(canvasId).future.length = 0
  }

  function pushPast(canvasId: string, entry: HistoryEntry) {
    const s = stacksFor(canvasId)
    s.past.push(entry)
    if (s.past.length > MAX_HISTORY)
      s.past.shift()
  }

  function applyAddPathSilent(canvasId: string, path: CanvasPath) {
    const canvas = canvases.value.find(c => c.id === canvasId)
    if (!canvas)
      return
    canvases.value = canvases.value.map(c =>
      c.id === canvasId ? { ...c, paths: [...c.paths, path] } : c,
    )
  }

  function applyDeletePathSilent(canvasId: string, pathId: string) {
    const canvas = canvases.value.find(c => c.id === canvasId)
    if (!canvas)
      return
    canvases.value = canvases.value.map(c =>
      c.id === canvasId ? { ...c, paths: c.paths.filter(p => p.id !== pathId) } : c,
    )
  }

  watch(
    [canvases, foregroundCanvasId],
    () => {
      persistToStorage(canvases.value, foregroundCanvasId.value)
    },
    { deep: true },
  )

  const snapshot = computed(() => canvases.value)

  function createCanvas(name: string, width = 800, height = 600, backgroundColor = '#ffffff'): Canvas {
    const canvas: Canvas = {
      id: nanoid(),
      name,
      width,
      height,
      backgroundColor,
      paths: [],
      createdAt: Date.now(),
    }
    canvases.value = [...canvases.value, canvas]
    if (foregroundCanvasId.value === null)
      foregroundCanvasId.value = canvas.id
    return canvas
  }

  function deleteCanvas(id: string): boolean {
    const before = canvases.value.length
    canvases.value = canvases.value.filter(c => c.id !== id)
    delete historyByCanvas[id]
    if (foregroundCanvasId.value === id) {
      const first = canvases.value[0]
      foregroundCanvasId.value = first ? first.id : null
    }
    return canvases.value.length < before
  }

  function getCanvas(id: string): Canvas | undefined {
    return canvases.value.find(c => c.id === id)
  }

  function listCanvases(): Canvas[] {
    return canvases.value
  }

  function addPath(canvasId: string, pathData: Omit<CanvasPath, 'id'>): CanvasPath | undefined {
    const canvas = getCanvas(canvasId)
    if (!canvas)
      return undefined
    const path: CanvasPath = { id: nanoid(), ...pathData }
    clearRedo(canvasId)
    pushPast(canvasId, { kind: 'add', canvasId, path: clonePath(path) })
    applyAddPathSilent(canvasId, path)
    return path
  }

  function deletePath(canvasId: string, pathId: string): boolean {
    const canvas = getCanvas(canvasId)
    if (!canvas)
      return false
    const path = canvas.paths.find(p => p.id === pathId)
    if (!path)
      return false
    clearRedo(canvasId)
    pushPast(canvasId, { kind: 'delete', canvasId, path: clonePath(path) })
    applyDeletePathSilent(canvasId, pathId)
    return true
  }

  function undo(canvasId: string): boolean {
    const s = stacksFor(canvasId)
    const entry = s.past.pop()
    if (!entry)
      return false
    if (entry.kind === 'add') {
      applyDeletePathSilent(canvasId, entry.path.id)
    }
    else {
      applyAddPathSilent(canvasId, clonePath(entry.path))
    }
    s.future.push(entry)
    return true
  }

  function redo(canvasId: string): boolean {
    const s = stacksFor(canvasId)
    const entry = s.future.pop()
    if (!entry)
      return false
    if (entry.kind === 'add') {
      applyAddPathSilent(canvasId, clonePath(entry.path))
    }
    else {
      applyDeletePathSilent(canvasId, entry.path.id)
    }
    s.past.push(entry)
    return true
  }

  function canUndo(canvasId: string): boolean {
    return stacksFor(canvasId).past.length > 0
  }

  function canRedo(canvasId: string): boolean {
    return stacksFor(canvasId).future.length > 0
  }

  function listPaths(canvasId: string): CanvasPath[] {
    return getCanvas(canvasId)?.paths ?? []
  }

  function toSVGString(canvasId: string): string {
    const canvas = getCanvas(canvasId)
    if (!canvas)
      return ''
    const pathElements = canvas.paths
      .map(
        p =>
          `  <path d="${escapeXml(p.d)}" stroke="${escapeXml(p.stroke)}" stroke-width="${p.strokeWidth}" fill="${escapeXml(p.fill)}" opacity="${p.opacity}" stroke-linecap="${p.strokeLinecap}" stroke-linejoin="${p.strokeLinejoin}" />`,
      )
      .join('\n')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" style="background:${escapeXml(canvas.backgroundColor)}">\n${pathElements}\n</svg>`
  }

  /** Phase 2: use with xsai `prepareStep` ([xsai#274](https://github.com/moeru-ai/xsai/issues/274)). */
  function toImageDataURL(canvasId: string): Promise<string> {
    const svg = toSVGString(canvasId)
    if (!svg)
      return Promise.resolve('')
    const canvas = getCanvas(canvasId)
    if (!canvas)
      return Promise.resolve('')
    return new Promise((resolve, reject) => {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.onload = () => {
        const el = document.createElement('canvas')
        el.width = canvas.width
        el.height = canvas.height
        const ctx = el.getContext('2d')
        if (!ctx) {
          URL.revokeObjectURL(url)
          reject(new Error('2d context unavailable'))
          return
        }
        ctx.drawImage(img, 0, 0)
        URL.revokeObjectURL(url)
        resolve(el.toDataURL('image/png'))
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Failed to render SVG to image'))
      }
      img.src = url
    })
  }

  function setForegroundCanvas(id: string | null) {
    foregroundCanvasId.value = id
  }

  return {
    canvases,
    snapshot,
    foregroundCanvasId,
    setForegroundCanvas,
    createCanvas,
    deleteCanvas,
    getCanvas,
    listCanvases,
    addPath,
    deletePath,
    undo,
    redo,
    canUndo,
    canRedo,
    listPaths,
    toSVGString,
    toImageDataURL,
  }
})

function escapeXml(s: string): string {
  return s
    .replace(RE_XML_AMP, '&amp;')
    .replace(RE_XML_LT, '&lt;')
    .replace(RE_XML_DQUOTE, '&quot;')
    .replace(RE_XML_SQUOTE, '&apos;')
}
