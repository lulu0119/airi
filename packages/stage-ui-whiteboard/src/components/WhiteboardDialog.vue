<script setup lang="ts">
import { useDeferredMount } from '@proj-airi/ui'
import { useDraggable, useEventListener } from '@vueuse/core'
import { ref, shallowRef, useTemplateRef } from 'vue'
import { useI18n } from 'vue-i18n'

import WhiteboardPanel from './WhiteboardPanel.vue'

const { t } = useI18n()
const { isReady } = useDeferredMount()

const open = defineModel<boolean>('open', { default: true })

const panelRef = useTemplateRef<HTMLElement>('panelRef')
const handleRef = useTemplateRef<HTMLElement>('handleRef')

const containerElement = shallowRef<HTMLElement | null>(
  typeof document !== 'undefined' ? document.documentElement : null,
)

// Resize state
const isResizing = ref(false)
const resizeDirection = ref<string>('')
const startX = ref(0)
const startY = ref(0)
const startWidth = ref(0)
const startHeight = ref(0)
const startLeft = ref(0)
const startTop = ref(0)

// Current dimensions
const width = ref(440)
const height = ref(480)

const { style: dragStyle } = useDraggable(panelRef, {
  handle: handleRef,
  initialValue: { x: 20, y: 96 },
  containerElement,
  preventDefault: true,
})

// Resize handlers
const resizeDirections = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

function handleResizeStart(event: MouseEvent, direction: string) {
  event.preventDefault()
  event.stopPropagation()

  isResizing.value = true
  resizeDirection.value = direction
  startX.value = event.clientX
  startY.value = event.clientY

  const rect = panelRef.value?.getBoundingClientRect()
  if (rect) {
    startWidth.value = rect.width
    startHeight.value = rect.height
    startLeft.value = rect.left
    startTop.value = rect.top
  }
}

useEventListener(document, 'mousemove', (event: MouseEvent) => {
  if (!isResizing.value || !panelRef.value)
    return

  const deltaX = event.clientX - startX.value
  const deltaY = event.clientY - startY.value

  let newWidth = startWidth.value
  let newHeight = startHeight.value
  let newLeft = startLeft.value
  let newTop = startTop.value

  // Horizontal resize
  if (resizeDirection.value.includes('e')) {
    newWidth = Math.max(280, startWidth.value + deltaX)
  }
  if (resizeDirection.value.includes('w')) {
    const proposedWidth = Math.max(280, startWidth.value - deltaX)
    newLeft = startLeft.value + (startWidth.value - proposedWidth)
    newWidth = proposedWidth
  }

  // Vertical resize
  if (resizeDirection.value.includes('s')) {
    newHeight = Math.max(200, startHeight.value + deltaY)
  }
  if (resizeDirection.value.includes('n')) {
    const proposedHeight = Math.max(200, startHeight.value - deltaY)
    newTop = startTop.value + (startHeight.value - proposedHeight)
    newHeight = proposedHeight
  }

  width.value = newWidth
  height.value = newHeight

  panelRef.value.style.width = `${newWidth}px`
  panelRef.value.style.height = `${newHeight}px`

  // Update position if resizing from top/left
  if (resizeDirection.value.includes('w')) {
    panelRef.value.style.left = `${newLeft}px`
  }
  if (resizeDirection.value.includes('n')) {
    panelRef.value.style.top = `${newTop}px`
  }
})

useEventListener(document, 'mouseup', () => {
  isResizing.value = false
  resizeDirection.value = ''
})
</script>

<template>
  <Teleport to="body">
    <div
      v-show="open"
      ref="panelRef"
      class="fixed z-[200] flex flex-col overflow-hidden border-4 border-primary-200/20 rounded-xl bg-primary-50/95 shadow-2xl backdrop-blur-md dark:border-primary-400/20 dark:bg-primary-950/90"
      :class="{ 'cursor-nwse-resize': isResizing }"
      :style="[dragStyle, { width: `${width}px`, height: `${height}px` }]"
      aria-modal="true"
      role="dialog"
      :aria-hidden="!open"
    >
      <div
        ref="handleRef"
        class="flex cursor-grab select-none items-center justify-between gap-2 border-b border-primary-200/30 px-3 py-2.5 active:cursor-grabbing dark:border-primary-400/25"
      >
        <span class="truncate text-sm text-primary-800 font-medium dark:text-primary-100">
          {{ t('stage.whiteboard.title') }}
        </span>
        <button
          type="button"
          class="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-lg text-neutral-500 transition-colors hover:bg-primary-200/30 dark:text-neutral-400 hover:text-neutral-800 dark:hover:bg-primary-400/20 dark:hover:text-neutral-100"
          :aria-label="t('stage.whiteboard.close')"
          @click="open = false"
        >
          <div class="i-ph:x-bold h-4 w-4" />
        </button>
      </div>
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <WhiteboardPanel v-if="isReady" />
      </div>

      <!-- Resize handles -->
      <div
        v-for="dir in resizeDirections"
        :key="dir"
        class="resize-handle"
        :class="[`handle-${dir}`, { active: resizeDirection === dir && isResizing }]"
        @mousedown="handleResizeStart($event, dir)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.resize-handle {
  position: absolute;
  z-index: 10;
  transition: background-color 0.15s ease;
}

.resize-handle:hover,
.resize-handle.active {
  background-color: rgba(var(--color-primary-500), 0.4);
}

/* Edge handles */
.handle-n {
  top: 0;
  left: 8px;
  right: 8px;
  height: 6px;
  cursor: n-resize;
}

.handle-s {
  bottom: 0;
  left: 8px;
  right: 8px;
  height: 6px;
  cursor: s-resize;
}

.handle-e {
  top: 8px;
  bottom: 8px;
  right: 0;
  width: 6px;
  cursor: e-resize;
}

.handle-w {
  top: 8px;
  bottom: 8px;
  left: 0;
  width: 6px;
  cursor: w-resize;
}

/* Corner handles */
.handle-nw {
  top: 0;
  left: 0;
  width: 12px;
  height: 12px;
  cursor: nw-resize;
  border-top-left-radius: 8px;
}

.handle-ne {
  top: 0;
  right: 0;
  width: 12px;
  height: 12px;
  cursor: ne-resize;
  border-top-right-radius: 8px;
}

.handle-sw {
  bottom: 0;
  left: 0;
  width: 12px;
  height: 12px;
  cursor: sw-resize;
  border-bottom-left-radius: 8px;
}

.handle-se {
  bottom: 0;
  right: 0;
  width: 12px;
  height: 12px;
  cursor: se-resize;
  border-bottom-right-radius: 8px;
}
</style>
