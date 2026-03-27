<script setup lang="ts">
import type { ChatToolResultRendererContext } from '../../../types/chat-tool-result'

import { Collapsible } from '@proj-airi/ui'
import { computed } from 'vue'

import { joinTextParts } from '../../../libs/chat-tool-result/normalize'

const props = defineProps<{
  ctx: ChatToolResultRendererContext
}>()

const plainText = computed(() => joinTextParts(props.ctx.normalized.content).trim())

const jsonPayload = computed(() => {
  const { normalized } = props.ctx
  const payload: Record<string, unknown> = {
    content: normalized.content,
  }
  if (normalized.structuredContent)
    payload.structuredContent = normalized.structuredContent
  if (normalized.isError != null)
    payload.isError = normalized.isError
  try {
    return JSON.stringify(payload, null, 2)
  }
  catch {
    return String(payload)
  }
})
</script>

<template>
  <Collapsible
    :class="[
      'rounded-lg px-2 pb-2 pt-2 flex flex-col gap-2 items-start w-full max-w-full',
      ctx.normalized.isError
        ? 'bg-red-100/50 dark:bg-red-950/40 border border-red-200/80 dark:border-red-900/60'
        : 'bg-neutral-100/70 dark:bg-neutral-900/50 border border-neutral-200/70 dark:border-neutral-700/60',
    ]"
  >
    <template #trigger="{ visible, setVisible }">
      <button
        type="button"
        class="w-full text-start text-sm"
        @click="setVisible(!visible)"
      >
        <span i-solar:clipboard-list-bold-duotone class="mr-1 inline-block translate-y-0.5 op-50" />
        <span font-medium>Tool result</span>
        <code v-if="ctx.mcpQualifiedToolName" class="ml-1 text-xs op-80">{{ ctx.mcpQualifiedToolName }}</code>
        <code v-else-if="ctx.xsaiToolName" class="ml-1 text-xs op-80">{{ ctx.xsaiToolName }}</code>
      </button>
    </template>
    <div
      v-if="plainText"
      class="w-full whitespace-pre-wrap break-words text-sm text-neutral-800 dark:text-neutral-200"
    >
      {{ plainText }}
    </div>
    <pre
      class="max-h-72 w-full overflow-auto rounded-md bg-neutral-900/5 p-2 text-xs font-mono dark:bg-white/5"
    >{{ jsonPayload }}</pre>
  </Collapsible>
</template>
