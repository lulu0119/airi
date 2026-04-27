import type { OIDCFlowParams, TokenResponse } from './auth-oidc'

import { Capacitor } from '@capacitor/core'
import { createAuthClient } from 'better-auth/vue'

import { useAuthStore } from '../stores/auth'
import { completeOIDCCallbackUrl } from './auth-callback'
import { buildAuthorizationURL, consumeFlowState, exchangeCodeForTokens, persistFlowState } from './auth-oidc'
import { openNativeAuthSession } from './native-auth'
import { isNgrokServerUrl, SERVER_URL } from './server'

export type OAuthProvider = 'google' | 'github'

// NOTICE: reads the same localStorage key ('auth/v1/token') that useAuthStore's
// `token` ref writes via useLocalStorage. We bypass the store here because
// authClient is initialized at module scope, before Pinia is active — calling
// useAuthStore() at this point would throw. The two stay in sync because
// useLocalStorage and raw localStorage share the same underlying storage entry.
export function getAuthToken(): string | null {
  return localStorage.getItem('auth/v1/token')
}

export const authClient = createAuthClient({
  baseURL: SERVER_URL,
  fetchOptions: {
    // NOTICE: better-auth's client hardcodes `credentials: "include"` by default
    // (config.mjs L40), which causes cookies to be sent alongside the Authorization
    // header. We override with "omit" so only the Bearer token is used for auth.
    // This works because restOfFetchOptions is spread AFTER the default (L47).
    credentials: 'omit',
    auth: {
      type: 'Bearer',
      token: () => getAuthToken() ?? '',
    },
    ...(isNgrokServerUrl()
      ? { headers: { 'ngrok-skip-browser-warning': 'true' } }
      : {}),
  },
})

let initialized = false

export function initializeAuth() {
  if (initialized)
    return

  // NOTICE: OIDC callback is handled by the dedicated callback page
  // (e.g. /auth/callback). initializeAuth() only restores existing
  // sessions and refresh schedules — it does NOT consume the code.

  fetchSession().catch(() => {})

  // Restore OIDC token refresh scheduling from persisted state
  const authStore = useAuthStore()
  authStore.restoreRefreshSchedule()

  authStore.onTokenRefreshed(async (accessToken) => {
    authStore.token = accessToken
    await fetchSession()
  })

  initialized = true
}

/**
 * Persist OIDC tokens locally and schedule refresh.
 */
export async function applyOIDCTokens(tokens: TokenResponse, clientId: string): Promise<void> {
  const authStore = useAuthStore()
  authStore.token = tokens.access_token
  if (tokens.refresh_token)
    authStore.refreshToken = tokens.refresh_token

  // Persist client info for refresh after page reload
  authStore.oidcClientId = clientId
  if (tokens.expires_in)
    authStore.tokenExpiry = Date.now() + tokens.expires_in * 1000

  authStore.scheduleTokenRefresh(tokens.expires_in)
}

export async function fetchSession() {
  const { data } = await authClient.getSession()
  const authStore = useAuthStore()

  if (data) {
    authStore.user = data.user
    authStore.session = data.session
    return true
  }

  // Session expired or invalid — clear stale auth state from localStorage
  authStore.user = null
  authStore.session = null
  authStore.token = null
  authStore.refreshToken = null
  authStore.clearOIDCState()
  return false
}

export async function listSessions() {
  return await authClient.listSessions()
}

export async function signOut() {
  const authStore = useAuthStore()
  authStore.clearOIDCState()

  // NOTICE: Server signOut is wrapped in try/catch so that local state cleanup
  // always runs regardless of server errors (e.g. network unreachable). User
  // intent to sign out is respected even if token revocation fails server-side.
  try {
    await authClient.signOut()
  }
  catch {
    // Swallow — local cleanup below ensures the user is signed out client-side.
  }

  authStore.user = null
  authStore.session = null
  authStore.token = null
  authStore.refreshToken = null
}

/**
 * Initiate OIDC Authorization Code + PKCE sign-in flow.
 * Builds the authorization URL, persists PKCE state, and navigates.
 */
export async function signInOIDC(params: OIDCFlowParams) {
  // Must pass `params` (incl. `provider`) so authorize URL can include `?provider=google` / github.
  const { url, flowState } = await buildAuthorizationURL(params)
  persistFlowState(flowState, params)

  let capacitorPlatform = 'web'
  try {
    capacitorPlatform = Capacitor.getPlatform()
  }
  catch {
    // no Capacitor
  }
  if (capacitorPlatform === 'ios') {
    const callbackUrl = await openNativeAuthSession(url.toString())
    await completeOIDCCallbackUrl(callbackUrl, {
      consumeFlowState,
      exchangeCodeForTokens,
      applyOIDCTokens,
      fetchSession,
    })
    return
  }
  if (capacitorPlatform !== 'web') {
    window.location.assign(url.toString())
    return
  }

  if (!params.provider) {
    window.location.href = url
    return
  }

  await authClient.signIn.social({
    provider: params.provider,
    callbackURL: url.toString(),
  })
}
