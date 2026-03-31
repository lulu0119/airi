import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

const KEY_VOICE_REPLY_INTERRUPT = 'settings/chat/interrupt/voice-reply'
const KEY_MESSAGE_REPLY_INTERRUPT = 'settings/chat/interrupt/message-reply'

export const useSettingsChatInterrupt = defineStore('settings-chat-interrupt', () => {
  const voiceReplyInterrupt = useLocalStorageManualReset<boolean>(KEY_VOICE_REPLY_INTERRUPT, true)
  const messageReplyInterrupt = useLocalStorageManualReset<boolean>(KEY_MESSAGE_REPLY_INTERRUPT, true)

  function resetVoiceReplyInterrupt() {
    voiceReplyInterrupt.reset()
  }

  function resetMessageReplyInterrupt() {
    messageReplyInterrupt.reset()
  }

  function resetState() {
    resetVoiceReplyInterrupt()
    resetMessageReplyInterrupt()
  }

  return {
    voiceReplyInterrupt,
    messageReplyInterrupt,
    resetVoiceReplyInterrupt,
    resetMessageReplyInterrupt,
    resetState,
  }
})
