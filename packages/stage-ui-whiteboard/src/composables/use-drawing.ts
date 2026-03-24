import type { CanvasPath } from '../types/canvas'

import { ref } from 'vue'

export function useDrawing(onPathComplete: (pathData: Omit<CanvasPath, 'id'>) => void) {
  const isDrawing = ref(false)
  const currentPathD = ref('')
  const stroke = ref('#000000')
  const strokeWidth = ref(2)

  function getPoint(e: PointerEvent, svg: SVGSVGElement) {
    const rect = svg.getBoundingClientRect()
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
  }

  function onPointerDown(e: PointerEvent, svg: SVGSVGElement) {
    if (e.button !== 0)
      return
    isDrawing.value = true
    const { x, y } = getPoint(e, svg)
    currentPathD.value = `M ${x} ${y}`
    svg.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: PointerEvent, svg: SVGSVGElement) {
    if (!isDrawing.value)
      return
    const { x, y } = getPoint(e, svg)
    currentPathD.value += ` L ${x} ${y}`
  }

  function onPointerUp() {
    if (!isDrawing.value)
      return
    isDrawing.value = false
    if (currentPathD.value) {
      onPathComplete({
        d: currentPathD.value,
        stroke: stroke.value,
        strokeWidth: strokeWidth.value,
        fill: 'none',
        opacity: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      })
    }
    currentPathD.value = ''
  }

  return {
    isDrawing,
    currentPathD,
    stroke,
    strokeWidth,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  }
}
