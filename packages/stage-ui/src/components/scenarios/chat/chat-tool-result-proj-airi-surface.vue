<script setup lang="ts">
import type { ChatToolResultRendererContext } from '../../../types/chat-tool-result'

import { parseProjAiriSurfaceV1 } from '@proj-airi/mcp-surface-contract'
import { computed } from 'vue'

const props = defineProps<{
  ctx: ChatToolResultRendererContext
}>()

const surface = computed(() =>
  parseProjAiriSurfaceV1(props.ctx.normalized.structuredContent),
)

const iframeTitle = computed(() => surface.value?.title ?? 'Embedded content')
</script>

<template>
  <div
    v-if="surface"
    :class="[
      'max-w-full w-full flex flex-col gap-2 border border-violet-200/80 rounded-xl bg-violet-50/40 p-2',
      'dark:border-violet-900/50 dark:bg-violet-950/30',
    ]"
  >
    <div
      :class="[
        'flex flex-wrap items-center gap-2 text-sm text-violet-900 dark:text-violet-100',
      ]"
    >
      <span i-solar:window-frame-bold-duotone class="op-70" />
      <span font-medium>{{ surface.title ?? 'Embedded content' }}</span>
      <a
        :href="surface.data.url"
        target="_blank"
        rel="noopener noreferrer"
        class="text-xs underline op-80 hover:op-100"
      >
        Open in new tab
      </a>
    </div>
    <p
      v-if="surface.summary"
      class="text-xs text-neutral-600 dark:text-neutral-400"
    >
      {{ surface.summary }}
    </p>
    <iframe
      :src="surface.data.url"
      :title="iframeTitle"
      :class="[
        'h-100 min-h-80 w-full border border-neutral-200/80 rounded-lg bg-white',
        'dark:border-neutral-700/80',
      ]"
      sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      referrerpolicy="no-referrer"
    />
  </div>
</template>
