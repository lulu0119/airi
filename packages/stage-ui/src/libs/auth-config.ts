// Centralized OIDC client configuration for browser-based stage clients.
// Electron has its own config because it uses a desktop loopback relay.

import { Capacitor } from '@capacitor/core'

import { NATIVE_AUTH_REDIRECT_URI } from './native-auth'

const CAPACITOR_WEBVIEW_REDIRECT_URI = 'capacitor://localhost/auth/callback'

function getCapacitorPlatform(): string {
  try {
    return Capacitor.getPlatform()
  }
  catch {
    return 'web'
  }
}

const capacitorPlatform = getCapacitorPlatform()
const isNativeClient = capacitorPlatform !== 'web'

export const OIDC_CLIENT_ID = import.meta.env.VITE_OIDC_CLIENT_ID || (isNativeClient ? 'airi-stage-pocket' : 'airi-stage-web')
export const OIDC_REDIRECT_URI = capacitorPlatform === 'ios'
  ? NATIVE_AUTH_REDIRECT_URI
  : isNativeClient
    ? CAPACITOR_WEBVIEW_REDIRECT_URI
    : `${window.location.origin}/auth/callback`
