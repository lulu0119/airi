<script setup lang="ts">
import type { Canvas, CanvasPath } from '../types/canvas'

import { Range } from '@proj-airi/ui'
import { useEventListener } from '@vueuse/core'
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDrawing } from '../composables/use-drawing'
import { useWhiteboardCanvasStore } from '../stores/whiteboard-canvas'
import { WB_DRAW_CURSOR_CSS, WB_ERASE_CURSOR_CSS } from '../utils/whiteboard-cursors'

const props = defineProps<{ canvas: Canvas }>()

const PRESET_STROKES = [
  '#18181b',
  '#ffffff',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#06b6d4',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
] as const

const { t } = useI18n()
const store = useWhiteboardCanvasStore()
const selectedPathId = ref<string | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const colorPopoverOpen = ref(false)
const colorInputRef = ref<HTMLInputElement | null>(null)
const widthDragTooltipOpen = ref(false)

type CanvasTool = 'draw' | 'erase'
const tool = ref<CanvasTool>('draw')

const { isDrawing, currentPathD, stroke, strokeWidth, onPointerDown, onPointerMove, onPointerUp } = useDrawing(
  (pathData) => {
    store.addPath(props.canvas.id, pathData)
  },
)

const paths = computed(() => {
  const current = store.snapshot.find(c => c.id === props.canvas.id)
  return current ? current.paths : props.canvas.paths
})

const canUndo = computed(() => store.canUndo(props.canvas.id))
const canRedo = computed(() => store.canRedo(props.canvas.id))

const widthAriaLabel = computed(() =>
  String(t('stage.whiteboard.toolbar.width-aria', {
    n: strokeWidth.value,
    unit: t('stage.whiteboard.toolbar.unit'),
  })),
)

const eraseDragging = ref(false)

/** Extra half-width around each stroke for easier hit testing in erase mode (px). */
const ERASE_HIT_PADDING = 14

function eraseHitStrokeWidth(p: CanvasPath): number {
  return Math.max(Number(p.strokeWidth) + ERASE_HIT_PADDING * 2, 22)
}

function pathEraseHitBind(p: CanvasPath): Record<string, string> {
  return { 'data-path-id': p.id }
}

const svgCanvasStyle = computed(() => ({
  background: props.canvas.backgroundColor,
  cursor: tool.value === 'erase' ? WB_ERASE_CURSOR_CSS : WB_DRAW_CURSOR_CSS,
}))

function beginEraseStroke(e: PointerEvent) {
  const svg = svgRef.value
  if (!svg || e.button !== 0)
    return
  eraseDragging.value = true
  try {
    svg.setPointerCapture(e.pointerId)
  }
  catch {
    // ignore (e.g. pointer already released)
  }
}

function erasePathsUnderPointer(e: PointerEvent) {
  let stack: Element[]
  try {
    stack = document.elementsFromPoint(e.clientX, e.clientY)
  }
  catch {
    return
  }
  const canvasId = props.canvas.id
  const seen = new Set<string>()
  for (const el of stack) {
    if (!(el instanceof Element))
      continue
    const id = el.getAttribute('data-path-id')
    if (!id || seen.has(id))
      continue
    seen.add(id)
    store.deletePath(canvasId, id)
    if (selectedPathId.value === id)
      selectedPathId.value = null
  }
}

function endEraseStroke() {
  eraseDragging.value = false
}

useEventListener(document, 'pointerup', () => {
  widthDragTooltipOpen.value = false
})
useEventListener(document, 'pointercancel', () => {
  widthDragTooltipOpen.value = false
})

function handleSvgPointerDown(e: PointerEvent) {
  if (!svgRef.value)
    return
  if (tool.value === 'erase') {
    selectedPathId.value = null
    if (e.button !== 0)
      return
    beginEraseStroke(e)
    erasePathsUnderPointer(e)
    return
  }
  selectedPathId.value = null
  onPointerDown(e, svgRef.value)
}

function handlePointerMove(e: PointerEvent) {
  if (!svgRef.value)
    return
  if (tool.value === 'erase' && eraseDragging.value) {
    erasePathsUnderPointer(e)
    return
  }
  onPointerMove(e, svgRef.value)
}

function onEraseHitPointerDown(e: PointerEvent) {
  e.stopPropagation()
  if (e.button !== 0)
    return
  beginEraseStroke(e)
  erasePathsUnderPointer(e)
}

function handleSvgPointerUp() {
  endEraseStroke()
  onPointerUp()
}

function handleSvgPointerCancel() {
  endEraseStroke()
}

function onSvgLostPointerCapture() {
  endEraseStroke()
}

function onVisiblePathPointerDown(e: PointerEvent, path: CanvasPath) {
  if (tool.value !== 'draw')
    return
  e.stopPropagation()
  selectedPathId.value = path.id
}

function handleKeyDown(e: KeyboardEvent) {
  const mod = e.metaKey || e.ctrlKey
  if (mod && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    if (e.shiftKey)
      store.redo(props.canvas.id)
    else
      store.undo(props.canvas.id)
    return
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPathId.value) {
    e.preventDefault()
    store.deletePath(props.canvas.id, selectedPathId.value)
    selectedPathId.value = null
  }
}

function pickPreset(hex: string) {
  stroke.value = hex
  colorPopoverOpen.value = false
}

function openSystemColorPicker() {
  colorInputRef.value?.click()
}

function onWidthSliderPointerDown() {
  widthDragTooltipOpen.value = true
}

const pathPointerClass = computed(() =>
  tool.value === 'erase' ? 'pointer-events-none' : 'cursor-pointer',
)

const toolBtnActive = 'bg-primary-300/40 text-primary-950 ring-1 ring-primary-400/40 dark:bg-primary-400/30 dark:text-primary-50 dark:ring-primary-400/35'
const toolBtnIdle = 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400'
</script>

<template>
  <!-- eslint-disable unocss/order -->
  <div
    class="max-w-full min-w-0 w-full flex flex-col items-center gap-2 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-400/50 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900"
    tabindex="0"
    @keydown="handleKeyDown"
  >
    <div class="max-w-full w-full flex flex-wrap items-center justify-center gap-2 px-1 py-1">
      <button
        type="button"
        class="max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 text-lg outline-none transition-colors transition-transform active:scale-95"
        :class="tool === 'draw' ? toolBtnActive : toolBtnIdle"
        :aria-label="String(t('stage.whiteboard.toolbar.tool-draw'))"
        @click="tool = 'draw'"
      >
        <div class="i-ph:pencil-simple-bold h-4 w-4" />
      </button>

      <button
        type="button"
        class="max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 text-lg outline-none transition-colors transition-transform active:scale-95"
        :class="tool === 'erase' ? toolBtnActive : toolBtnIdle"
        :aria-label="String(t('stage.whiteboard.toolbar.tool-erase'))"
        @click="tool = 'erase'"
      >
        <div class="i-ph:eraser-bold h-4 w-4" />
      </button>

      <div class="hidden h-6 w-px shrink-0 bg-neutral-200 sm:block dark:bg-neutral-700" />

      <button
        type="button"
        class="max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 text-lg outline-none transition-colors transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :class="toolBtnIdle"
        :disabled="!canUndo"
        :aria-label="String(t('stage.whiteboard.toolbar.undo'))"
        @click="store.undo(canvas.id)"
      >
        <div class="i-ph:arrow-u-up-left-bold h-4 w-4" />
      </button>

      <button
        type="button"
        class="max-h-[10lh] min-h-[1lh] flex items-center justify-center rounded-md p-2 text-lg outline-none transition-colors transition-transform active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        :class="toolBtnIdle"
        :disabled="!canRedo"
        :aria-label="String(t('stage.whiteboard.toolbar.redo'))"
        @click="store.redo(canvas.id)"
      >
        <div class="i-ph:arrow-u-up-right-bold h-4 w-4" />
      </button>

      <template v-if="tool === 'draw'">
        <div class="hidden h-6 w-px shrink-0 bg-neutral-200 sm:block dark:bg-neutral-700" />

        <PopoverRoot v-model:open="colorPopoverOpen">
          <PopoverTrigger as-child>
            <button
              type="button"
              class="h-6 w-6 shrink-0 cursor-pointer rounded-full ring-2 ring-neutral-200 transition-transform hover:scale-105 dark:ring-neutral-600"
              :style="{ backgroundColor: stroke }"
              :aria-label="String(t('stage.whiteboard.toolbar.color'))"
            />
          </PopoverTrigger>
          <PopoverPortal>
            <PopoverContent
              side="bottom"
              align="center"
              :side-offset="6"
              class="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 relative z-[300] w-[204px] border border-neutral-200 rounded-xl bg-white p-3 shadow-lg sm:w-[216px] dark:border-neutral-700 dark:bg-neutral-900"
            >
              <div class="flex flex-wrap justify-center gap-x-3 gap-y-3">
                <button
                  v-for="hex in PRESET_STROKES"
                  :key="hex"
                  type="button"
                  class="h-6 w-6 shrink-0 rounded-full ring-1 ring-neutral-200 transition-shadow dark:ring-neutral-600"
                  :class="stroke === hex ? 'ring-2 ring-primary-500 ring-offset-2 dark:ring-offset-neutral-900' : 'hover:ring-2 hover:ring-neutral-300 dark:hover:ring-neutral-500'"
                  :style="{ backgroundColor: hex }"
                  :aria-label="hex"
                  @click="pickPreset(hex)"
                />
              </div>
              <button
                type="button"
                class="mt-3 w-full rounded-lg bg-neutral-100 px-2 py-1.5 text-xs text-neutral-800 font-medium dark:bg-neutral-800 dark:text-neutral-200"
                @click="openSystemColorPicker"
              >
                {{ t('stage.whiteboard.toolbar.custom-color') }}
              </button>
              <input
                ref="colorInputRef"
                v-model="stroke"
                type="color"
                class="pointer-events-none absolute h-0 w-0 opacity-0"
                tabindex="-1"
                aria-hidden="true"
                @change="colorPopoverOpen = false"
              >
            </PopoverContent>
          </PopoverPortal>
        </PopoverRoot>

        <div
          class="relative flex max-w-[200px] min-w-0 flex-1 touch-none items-center"
          role="group"
          :aria-label="widthAriaLabel"
          @pointerdown="onWidthSliderPointerDown"
        >
          <Range v-model="strokeWidth" :min="1" :max="20" :step="1" class="min-w-0 flex-1" />
          <div
            v-show="widthDragTooltipOpen"
            class="pointer-events-none absolute bottom-full left-1/2 z-[300] mb-1.5 max-w-none -translate-x-1/2 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-xs text-white shadow-md tabular-nums dark:bg-neutral-100 dark:text-neutral-900"
            aria-hidden="true"
          >
            {{ strokeWidth }}{{ t('stage.whiteboard.toolbar.unit') }}
          </div>
        </div>
      </template>
    </div>

    <svg
      ref="svgRef"
      :width="canvas.width"
      :height="canvas.height"
      class="max-w-full touch-none rounded-lg border border-neutral-200 dark:border-neutral-700"
      :style="svgCanvasStyle"
      @pointerdown="handleSvgPointerDown"
      @pointermove="handlePointerMove"
      @pointerup="handleSvgPointerUp"
      @pointercancel="handleSvgPointerCancel"
      @lostpointercapture="onSvgLostPointerCapture"
    >
      <path
        v-for="p in paths"
        :key="p.id"
        :d="p.d"
        :stroke="selectedPathId === p.id ? '#2080f0' : p.stroke"
        :stroke-width="p.strokeWidth"
        :fill="p.fill"
        :opacity="p.opacity"
        :stroke-linecap="p.strokeLinecap"
        :stroke-linejoin="p.strokeLinejoin"
        :class="pathPointerClass"
        @pointerdown.stop="onVisiblePathPointerDown($event, p)"
      />
      <g v-if="tool === 'erase'">
        <path
          v-for="p in paths"
          :key="`${p.id}-erase-hit`"
          v-bind="pathEraseHitBind(p)"
          :d="p.d"
          stroke="black"
          :stroke-width="eraseHitStrokeWidth(p)"
          fill="none"
          stroke-opacity="0"
          :stroke-linecap="p.strokeLinecap ?? 'round'"
          :stroke-linejoin="p.strokeLinejoin ?? 'round'"
          pointer-events="stroke"
          class="cursor-inherit"
          @pointerdown.stop="onEraseHitPointerDown"
        />
      </g>
      <path
        v-if="isDrawing && currentPathD"
        :d="currentPathD"
        :stroke="stroke"
        :stroke-width="strokeWidth"
        fill="none"
        opacity="0.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </div>
  <!-- eslint-enable unocss/order -->
</template>
