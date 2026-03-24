<script setup lang="ts">
import type { Canvas, CanvasPath } from '../types/canvas'

import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useDrawing } from '../composables/use-drawing'
import { useWhiteboardCanvasStore } from '../stores/whiteboard-canvas'

const props = defineProps<{ canvas: Canvas }>()

const { t } = useI18n()
const store = useWhiteboardCanvasStore()
const selectedPathId = ref<string | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)

const { isDrawing, currentPathD, stroke, strokeWidth, onPointerDown, onPointerMove, onPointerUp } = useDrawing(
  (pathData) => {
    store.addPath(props.canvas.id, pathData)
  },
)

const paths = computed(() => {
  const current = store.snapshot.find(c => c.id === props.canvas.id)
  return current ? current.paths : props.canvas.paths
})

function handlePointerDown(e: PointerEvent) {
  if (!svgRef.value)
    return
  selectedPathId.value = null
  onPointerDown(e, svgRef.value)
}

function handlePointerMove(e: PointerEvent) {
  if (!svgRef.value)
    return
  onPointerMove(e, svgRef.value)
}

function selectPath(e: Event, path: CanvasPath) {
  e.stopPropagation()
  selectedPathId.value = path.id
}

function handleKeyDown(e: KeyboardEvent) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPathId.value) {
    store.deletePath(props.canvas.id, selectedPathId.value)
    selectedPathId.value = null
  }
}
</script>

<template>
  <div class="wb-svg-wrap" tabindex="0" @keydown="handleKeyDown">
    <div class="wb-toolbar">
      <label>
        {{ t('stage.whiteboard.toolbar.color') }}:
        <input v-model="stroke" type="color">
      </label>
      <label>
        {{ t('stage.whiteboard.toolbar.width') }}:
        <input v-model.number="strokeWidth" type="range" min="1" max="20">
        {{ strokeWidth }}{{ t('stage.whiteboard.toolbar.unit') }}
      </label>
    </div>
    <svg
      ref="svgRef"
      :width="canvas.width"
      :height="canvas.height"
      :style="{ background: canvas.backgroundColor, cursor: 'crosshair' }"
      @pointerdown="handlePointerDown"
      @pointermove="handlePointerMove"
      @pointerup="onPointerUp"
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
        style="cursor: pointer"
        @pointerdown.stop="selectPath($event, p)"
      />
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
</template>

<style scoped>
.wb-svg-wrap {
  outline: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.wb-svg-wrap svg {
  border: 1px solid #e0e0e0;
  border-radius: 4px;
}
.wb-toolbar {
  display: flex;
  gap: 16px;
  align-items: center;
  font-size: 13px;
  padding: 4px 0;
}
.wb-toolbar label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wb-toolbar input[type="color"] {
  width: 28px;
  height: 28px;
  border: none;
  padding: 0;
  cursor: pointer;
}
</style>
