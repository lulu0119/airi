<script setup lang="ts">
import {
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import WhiteboardSvgCanvas from './WhiteboardSvgCanvas.vue'

import { useWhiteboardCanvasStore } from '../stores/whiteboard-canvas'

const { t } = useI18n()
const store = useWhiteboardCanvasStore()

const canvasList = computed(() => store.snapshot)

const foregroundId = computed({
  get: () => store.foregroundCanvasId,
  set: (val: string | null) => {
    store.setForegroundCanvas(val)
  },
})

const foregroundCanvas = computed(() =>
  canvasList.value.find(c => c.id === foregroundId.value) ?? null,
)

const createOpen = ref(false)
const createName = ref('')
const deleteOpen = ref(false)
const pendingDeleteId = ref<string | null>(null)

watch(createOpen, (open) => {
  if (!open)
    createName.value = ''
})

watch(deleteOpen, (open) => {
  if (!open)
    pendingDeleteId.value = null
})

function openCreateDialog() {
  createName.value = ''
  createOpen.value = true
}

function submitCreate() {
  const name = createName.value.trim() || String(t('stage.whiteboard.default-canvas-name'))
  store.createCanvas(name)
  createOpen.value = false
}

function openDeleteDialogFor(id: string) {
  pendingDeleteId.value = id
  deleteOpen.value = true
}

const pendingDeleteCanvas = computed(() =>
  pendingDeleteId.value
    ? canvasList.value.find(c => c.id === pendingDeleteId.value) ?? null
    : null,
)

function confirmDelete() {
  const id = pendingDeleteId.value
  if (id)
    store.deleteCanvas(id)
  deleteOpen.value = false
}

const createDialogOpen = computed({
  get: () => createOpen.value,
  set: v => (createOpen.value = v),
})

const deleteDialogOpen = computed({
  get: () => deleteOpen.value,
  set: v => (deleteOpen.value = v),
})

function selectCanvas(id: string) {
  store.setForegroundCanvas(id)
}
</script>

<template>
  <div class="h-full min-h-0 flex flex-1 flex-col overflow-hidden px-2 pb-2 pt-2">
    <div v-if="canvasList.length > 0" class="mb-2 min-h-0 flex shrink-0 flex-wrap items-center gap-2">
      <div
        v-for="c in canvasList"
        :key="c.id"
        class="inline-flex items-stretch overflow-hidden rounded-lg text-xs font-medium transition-colors md:text-sm"
        :class="c.id === foregroundId
          ? 'ring-1 ring-primary-400/40 dark:ring-primary-400/35'
          : 'ring-1 ring-neutral-200/70 dark:ring-neutral-700/80'"
      >
        <button
          type="button"
          class="px-3 py-1.5 transition-colors"
          :class="c.id === foregroundId
            ? 'bg-primary-300/40 text-primary-950 dark:bg-primary-400/30 dark:text-primary-50'
            : 'bg-white/40 text-neutral-700 hover:bg-primary-300/20 dark:bg-neutral-950/40 dark:text-neutral-200 dark:hover:bg-primary-400/15'"
          @click="selectCanvas(c.id)"
        >
          {{ c.name }}
        </button>
        <button
          type="button"
          class="flex items-center justify-center border-l border-neutral-200/70 px-2 outline-none transition-colors active:scale-95 dark:border-neutral-600/70"
          :class="c.id === foregroundId
            ? 'bg-primary-300/30 text-neutral-600 hover:bg-red-500/15 hover:text-red-600 dark:bg-primary-400/20 dark:text-neutral-300 dark:hover:bg-red-500/20 dark:hover:text-red-400'
            : 'bg-white/30 text-neutral-500 hover:bg-red-500/10 hover:text-red-600 dark:bg-neutral-950/30 dark:text-neutral-400 dark:hover:bg-red-500/15 dark:hover:text-red-400'"
          :aria-label="String(t('stage.whiteboard.delete-canvas-named', { name: c.name }))"
          :title="t('stage.whiteboard.delete-canvas')"
          @click.stop="openDeleteDialogFor(c.id)"
        >
          <div class="i-solar:trash-bin-2-bold-duotone text-base" />
        </button>
      </div>
      <button
        type="button"
        class="max-h-[10lh] min-h-[1lh] inline-flex items-center justify-center rounded-md bg-neutral-100 p-2 text-lg text-neutral-500 outline-none transition-colors transition-transform active:scale-95 dark:bg-neutral-800 dark:text-neutral-400"
        :aria-label="String(t('stage.whiteboard.create-canvas'))"
        :title="String(t('stage.whiteboard.create-canvas'))"
        @click="openCreateDialog"
      >
        <div class="i-solar:add-circle-bold-duotone" />
      </button>
    </div>

    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-4 px-2 text-center text-sm text-neutral-500 dark:text-neutral-400"
    >
      <p>{{ t('stage.whiteboard.empty-hint') }}</p>
      <button
        type="button"
        class="inline-flex items-center gap-2 rounded-lg bg-primary-500 px-3 py-1.5 text-sm text-white font-medium shadow-sm dark:bg-primary-600 hover:bg-primary-600 dark:hover:bg-primary-500"
        :aria-label="String(t('stage.whiteboard.create-first'))"
        @click="openCreateDialog"
      >
        <div class="i-solar:add-circle-bold-duotone text-lg" />
        {{ t('stage.whiteboard.create-first') }}
      </button>
    </div>

    <div
      v-if="foregroundCanvas"
      class="min-h-0 flex flex-1 items-center justify-center overflow-auto"
    >
      <WhiteboardSvgCanvas :canvas="foregroundCanvas" />
    </div>

    <DialogRoot v-model:open="createDialogOpen">
      <DialogPortal>
        <DialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogContent class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-1/2 top-1/2 z-50 max-w-md w-full rounded-2xl bg-white p-0 shadow-xl -translate-x-1/2 -translate-y-1/2 dark:bg-neutral-900">
          <div class="flex items-center justify-between border-b border-neutral-100 p-4 dark:border-neutral-800">
            <DialogTitle class="text-lg font-semibold">
              {{ t('stage.whiteboard.create-canvas') }}
            </DialogTitle>
            <button
              class="rounded-full p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              type="button"
              @click="createDialogOpen = false"
            >
              <div class="i-solar:close-circle-bold text-xl" />
            </button>
          </div>
          <div class="p-4 space-y-4">
            <label class="flex flex-col gap-2">
              <span class="text-sm text-neutral-800 font-medium dark:text-neutral-200">
                {{ t('stage.whiteboard.canvas-name') }}
              </span>
              <input
                v-model="createName"
                type="text"
                class="w-full border border-neutral-200 rounded-lg bg-white px-3 py-2 text-sm text-neutral-900 outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 focus:ring-2 focus:ring-primary-400/50"
                :placeholder="String(t('stage.whiteboard.canvas-name-placeholder'))"
              >
            </label>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class="rounded-lg bg-neutral-200/80 px-3 py-1.5 text-sm text-neutral-800 font-medium dark:bg-neutral-700/80 dark:text-neutral-100"
                @click="createDialogOpen = false"
              >
                {{ t('stage.whiteboard.cancel') }}
              </button>
              <button
                type="button"
                class="rounded-lg bg-primary-500 px-3 py-1.5 text-sm text-white font-medium hover:bg-primary-600"
                @click="submitCreate"
              >
                {{ t('stage.whiteboard.confirm-create') }}
              </button>
            </div>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <DialogRoot v-model:open="deleteDialogOpen">
      <DialogPortal>
        <DialogOverlay class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50 backdrop-blur-sm" />
        <DialogContent class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-1/2 top-1/2 z-50 max-w-md w-full rounded-2xl bg-white p-0 shadow-xl -translate-x-1/2 -translate-y-1/2 dark:bg-neutral-900">
          <div class="border-b border-neutral-100 p-4 dark:border-neutral-800">
            <DialogTitle class="text-lg font-semibold">
              {{ t('stage.whiteboard.delete-title') }}
            </DialogTitle>
            <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
              <template v-if="pendingDeleteCanvas">
                {{ t('stage.whiteboard.delete-confirm-named', { name: pendingDeleteCanvas.name }) }}
              </template>
              <template v-else>
                {{ t('stage.whiteboard.delete-confirm') }}
              </template>
            </p>
          </div>
          <div class="flex justify-end gap-2 p-4">
            <button
              type="button"
              class="rounded-lg bg-neutral-200/80 px-3 py-1.5 text-sm text-neutral-800 font-medium dark:bg-neutral-700/80 dark:text-neutral-100"
              @click="deleteDialogOpen = false"
            >
              {{ t('stage.whiteboard.cancel') }}
            </button>
            <button
              type="button"
              class="rounded-lg bg-red-600 px-3 py-1.5 text-sm text-white font-medium hover:bg-red-700"
              @click="confirmDelete"
            >
              {{ t('stage.whiteboard.delete') }}
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  </div>
</template>
