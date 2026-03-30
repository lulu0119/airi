import { useChatOrchestratorStore } from '../stores/chat'

/**
 * Voice-only hook: call when the user starts speaking (VAD / streaming STT onSpeechStart).
 * Uses the same interrupt pipeline as text sends (`useChatOrchestratorStore` + `ingest`).
 */
export function useChatTurnInterrupt() {
  const chatOrchestrator = useChatOrchestratorStore()

  function notifyVoiceActivityStart() {
    chatOrchestrator.applyUserTurnInterrupt('voice')
  }

  return { notifyVoiceActivityStart }
}
