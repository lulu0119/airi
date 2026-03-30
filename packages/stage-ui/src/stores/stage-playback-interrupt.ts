import { defineStore } from 'pinia'

/**
 * Host (Stage.vue) registers a handler so VAD / ChatArea can stop TTS and
 * auxiliary queues without importing the stage component graph.
 */
export const useStagePlaybackInterruptStore = defineStore('stage-playback-interrupt', () => {
  let handler: (() => void) | null = null

  function register(fn: () => void) {
    handler = fn
  }

  function unregister() {
    handler = null
  }

  function interruptAssistantPlayback() {
    handler?.()
  }

  return {
    register,
    unregister,
    interruptAssistantPlayback,
  }
})
