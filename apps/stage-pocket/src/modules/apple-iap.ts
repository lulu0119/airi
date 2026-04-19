import { Capacitor } from '@capacitor/core'
import { AppleIap } from '@proj-airi/capacitor-plugin-apple-iap'
import { SERVER_URL } from '@proj-airi/stage-ui/libs/server'
import { useAuthStore } from '@proj-airi/stage-ui/stores/auth'
import { v5 as uuidv5 } from 'uuid'
import { watch } from 'vue'

// NOTICE:
// This namespace UUID must stay in sync with
// `apps/server/src/utils/apple-iap.ts :: APPLE_IAP_NAMESPACE_UUID`.
// The server uses the same value to verify the `appAccountToken` embedded
// in every signed StoreKit 2 transaction. Rotating it invalidates
// in-flight transactions — only change with a coordinated client+server
// release.
const APPLE_IAP_NAMESPACE_UUID = 'f4e8a0c2-2c6b-4e1b-b2a5-6d7f3b5a8c91'

/**
 * Bridge StoreKit 2 on iOS builds to the AIRI backend.
 *
 * Behavior:
 * - On non-iOS platforms this is a no-op.
 * - When the user becomes authenticated (or their token rotates via OIDC
 *   refresh), re-`configure` the native plugin with a fresh bearer token
 *   and a deterministic `appAccountToken` derived from the user id.
 *
 * After `configure` the native side will:
 * - Drain `Transaction.unfinished` (re-submits any JWS the device still
 *   holds from a previous session that never got a 2xx from the server).
 * - Spin up a long-lived `Transaction.updates` listener for server-side
 *   renewals and Ask-to-Buy resolutions.
 */
export function setupAppleIap(): void {
  if (Capacitor.getPlatform() !== 'ios')
    return

  const auth = useAuthStore()

  watch(
    () => [auth.user?.id, auth.token] as const,
    async ([userId, token]) => {
      if (!userId || !token)
        return

      try {
        await AppleIap.configure({
          serverBaseUrl: SERVER_URL,
          bearerToken: token,
          appAccountToken: uuidv5(userId, APPLE_IAP_NAMESPACE_UUID),
        })
      }
      catch (error) {
        console.warn('[apple-iap] configure failed', error)
      }
    },
    { immediate: true },
  )
}
