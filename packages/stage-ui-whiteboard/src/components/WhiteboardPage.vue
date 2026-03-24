<script setup lang="ts">
import { useI18n } from 'vue-i18n'

import WhiteboardCanvasArea from './WhiteboardCanvasArea.vue'

const { t } = useI18n()
</script>

<template>
  <div class="wb-page">
    <header class="wb-header">
      <h1 class="wb-title">
        {{ t('stage.whiteboard.title') }}
      </h1>
    </header>
    <WhiteboardCanvasArea />
  </div>
</template>

<style scoped>
.wb-page {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--wb-bg, #fafafa);
  color: var(--wb-fg, #111);
}
.wb-header {
  padding: 16px 20px 8px;
  border-bottom: 1px solid var(--wb-border, #e5e5e5);
}
.wb-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}
</style>
