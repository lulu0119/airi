import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { defineStore } from 'pinia'

const LEGACY_VOICE_STOP_PLAYBACK = 'settings/hearing/voice-barge-in-interrupt-playback'
const LEGACY_VOICE_ABORT_LLM = 'settings/hearing/voice-barge-in-abort-llm'

const KEY_VOICE_STOP = 'settings/chat/interrupt/voice/stop-playback'
const KEY_VOICE_ABORT = 'settings/chat/interrupt/voice/abort-llm'
const KEY_TEXT_STOP = 'settings/chat/interrupt/text/stop-playback'
const KEY_TEXT_ABORT = 'settings/chat/interrupt/text/abort-llm'

function migrateVoiceKeysFromHearing() {
  if (typeof localStorage === 'undefined')
    return
  const pairs: [string, string][] = [
    [KEY_VOICE_STOP, LEGACY_VOICE_STOP_PLAYBACK],
    [KEY_VOICE_ABORT, LEGACY_VOICE_ABORT_LLM],
  ]
  for (const [nextKey, prevKey] of pairs) {
    if (localStorage.getItem(nextKey) === null && localStorage.getItem(prevKey) !== null)
      localStorage.setItem(nextKey, localStorage.getItem(prevKey)!)
  }
}

export const useSettingsChatInterrupt = defineStore('settings-chat-interrupt', () => {
  migrateVoiceKeysFromHearing()

  const voiceInterruptStopPlayback = useLocalStorageManualReset<boolean>(KEY_VOICE_STOP, true)
  const voiceInterruptAbortLlm = useLocalStorageManualReset<boolean>(KEY_VOICE_ABORT, true)
  const textInterruptStopPlayback = useLocalStorageManualReset<boolean>(KEY_TEXT_STOP, true)
  const textInterruptAbortLlm = useLocalStorageManualReset<boolean>(KEY_TEXT_ABORT, true)

  function resetVoiceInterruptSettings() {
    voiceInterruptStopPlayback.reset()
    voiceInterruptAbortLlm.reset()
  }

  function resetTextInterruptSettings() {
    textInterruptStopPlayback.reset()
    textInterruptAbortLlm.reset()
  }

  function resetState() {
    resetVoiceInterruptSettings()
    resetTextInterruptSettings()
  }

  return {
    voiceInterruptStopPlayback,
    voiceInterruptAbortLlm,
    textInterruptStopPlayback,
    textInterruptAbortLlm,
    resetVoiceInterruptSettings,
    resetTextInterruptSettings,
    resetState,
  }
})
