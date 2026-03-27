<script setup lang="ts">
import type { CommonContentPart } from '@xsai/shared-chat'

import type { ChatSlices } from '../../../types/chat'
import type { ChatToolResultRendererContext } from '../../../types/chat-tool-result'

import { computed } from 'vue'

import ChatToolResultFallback from './chat-tool-result-fallback.vue'

import { normalizeToolResult } from '../../../libs/chat-tool-result/normalize'
import { resolveMcpQualifiedToolName, resolveXsaiToolName } from '../../../libs/chat-tool-result/resolve-mcp-call'
import { resolveChatToolResultRenderer } from '../../../stores/chat-tool-result-registry'

const props = defineProps<{
  toolCallId: string
  result?: string | CommonContentPart[]
  messageSlices: ChatSlices[]
}>()

const normalized = computed(() => normalizeToolResult(props.result))

const rendererContext = computed<ChatToolResultRendererContext>(() => ({
  toolCallId: props.toolCallId,
  xsaiToolName: resolveXsaiToolName(props.messageSlices, props.toolCallId),
  mcpQualifiedToolName: resolveMcpQualifiedToolName(props.messageSlices, props.toolCallId),
  normalized: normalized.value,
}))

const picked = computed(() => resolveChatToolResultRenderer(rendererContext.value))

const activeComponent = computed(() => picked.value?.component ?? ChatToolResultFallback)
</script>

<template>
  <div class="mb-2 max-w-full w-full">
    <component
      :is="activeComponent"
      :ctx="rendererContext"
    />
  </div>
</template>
