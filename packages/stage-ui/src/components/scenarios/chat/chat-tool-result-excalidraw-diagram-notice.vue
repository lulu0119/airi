<script setup lang="ts">
import type { ChatToolResultRendererContext } from '../../../types/chat-tool-result'

import { computed } from 'vue'

import { joinTextParts } from '../../../libs/chat-tool-result/normalize'

const props = defineProps<{
  ctx: ChatToolResultRendererContext
}>()

const checkpointId = computed(() => {
  const id = props.ctx.normalized.structuredContent?.checkpointId
  return typeof id === 'string' ? id : null
})

const summary = computed(() => {
  const text = joinTextParts(props.ctx.normalized.content)
  const line = text.split('\n').find(l => l.trim().length > 0)
  return line?.trim() ?? text.trim()
})
</script>

<template>
  <div
    v-if="checkpointId"
    class="max-w-full w-full flex flex-col gap-2 border border-sky-200/80 rounded-xl bg-sky-50/50 p-3 text-sm dark:border-sky-900/50 dark:bg-sky-950/25"
  >
    <div class="flex items-center gap-2 text-sky-950 dark:text-sky-100">
      <span i-solar:pen-new-square-bold-duotone class="op-70" />
      <span font-medium>Excalidraw diagram</span>
    </div>
    <p class="text-neutral-700 dark:text-neutral-300">
      {{ summary }}
    </p>
    <p class="text-xs text-neutral-500 dark:text-neutral-400">
      Interactive MCP App UI is not embedded here yet. When the model exports the scene, a preview appears if the tool returns an
      <code class="rounded bg-black/5 px-1 dark:bg-white/10">excalidraw.com</code>
      link.
    </p>
  </div>
</template>
