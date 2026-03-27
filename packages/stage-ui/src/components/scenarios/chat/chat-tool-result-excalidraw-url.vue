<script setup lang="ts">
import type { ChatToolResultRendererContext } from '../../../types/chat-tool-result'

import { computed } from 'vue'

import { joinTextParts } from '../../../libs/chat-tool-result/normalize'

const props = defineProps<{
  ctx: ChatToolResultRendererContext
}>()

const EXCALIDRAW_JSON_URL = /https:\/\/excalidraw\.com\/#json=[^\s"'<>]+/i

const url = computed(() => {
  const text = joinTextParts(props.ctx.normalized.content)
  const m = text.match(EXCALIDRAW_JSON_URL)
  return m ? m[0] : null
})
</script>

<template>
  <div
    v-if="url"
    class="max-w-full w-full flex flex-col gap-2 border border-emerald-200/80 rounded-xl bg-emerald-50/40 p-2 dark:border-emerald-900/50 dark:bg-emerald-950/30"
  >
    <div class="flex flex-wrap items-center gap-2 text-sm text-emerald-900 dark:text-emerald-100">
      <span i-solar:diagram-bold-duotone class="op-70" />
      <span font-medium>Excalidraw</span>
      <a
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs underline op-80 hover:op-100"
      >
        Open in new tab
      </a>
    </div>
    <iframe
      :src="url"
      title="Excalidraw"
      class="h-100 min-h-80 w-full border border-neutral-200/80 rounded-lg bg-white dark:border-neutral-700/80"
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      referrerpolicy="no-referrer"
    />
  </div>
</template>
