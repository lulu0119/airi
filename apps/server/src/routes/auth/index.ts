import type { Context } from 'hono'

import type { AuthInstance } from '../../libs/auth'
import type { Database } from '../../libs/db'
import type { Env } from '../../libs/env'
import type { ConfigKVService } from '../../services/config-kv'
import type { HonoEnv } from '../../types/hono'

import { oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from '@better-auth/oauth-provider'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

import { ensureDynamicFirstPartyRedirectUri } from '../../libs/auth'
import { rateLimiter } from '../../middlewares/rate-limit'
import { getServerAuthUiDistDir, renderOidcSocialPostBridgeHtml, renderServerAuthUiHtml, SERVER_AUTH_UI_BASE_PATH } from '../../utils/server-auth-ui'
import { createElectronCallbackRelay } from '../oidc/electron-callback'
import { createOIDCTokenAuthRoute } from '../oidc/token-auth'

const RE_SERVER_AUTH_UI_BASE_PATH = /^\/_ui\/server-auth/

/** Set on GET /oauth2/authorize?provider=…; read on GET /sign-in (Referer is often empty in WKWebView). */
const OAUTH_SIGN_IN_PROVIDER_HINT = 'oauth_sign_in_provider'

/**
 * The oauth2 plugin redirects to /sign-in with OIDC query params but **drops** `provider`.
 * Recovery: 1) query 2) short HttpOnly cookie from authorize 3) Referer (non‑WebView).
 */
function getOauthProviderHint(c: Context): 'github' | 'google' | undefined {
  const direct = c.req.query('provider')
  if (direct === 'github' || direct === 'google')
    return direct

  const fromCookie = getCookie(c, OAUTH_SIGN_IN_PROVIDER_HINT)
  if (fromCookie === 'github' || fromCookie === 'google')
    return fromCookie

  const ref = c.req.header('Referer') ?? c.req.header('referer') ?? ''
  if (!ref)
    return undefined

  try {
    const referer = new URL(ref)
    if (!referer.pathname.includes('/oauth2/authorize'))
      return undefined

    const p = referer.searchParams.get('provider')
    if (p === 'github' || p === 'google')
      return p
  }
  catch {
    return undefined
  }
  return undefined
}

export interface AuthRoutesDeps {
  auth: AuthInstance
  db: Database
  env: Env
  configKV: ConfigKVService
}

/**
 * All auth-related routes: sign-in page, rate-limited better-auth
 * helper routes, electron callback relay, catch-all, and
 * well-known metadata endpoints.
 *
 * Mounted at the root level because routes span multiple prefixes
 * (`/sign-in`, `/api/auth/*`, `/.well-known/*`).
 */
export async function createAuthRoutes(deps: AuthRoutesDeps) {
  async function handleAuthRequest(request: Request): Promise<Response> {
    const response = await deps.auth.handler(request)

    if (!(response instanceof Response))
      throw new TypeError('Expected auth handler to return a Response')

    return response
  }

  return new Hono<HonoEnv>()
    .use(`${SERVER_AUTH_UI_BASE_PATH}/*`, serveStatic({
      root: getServerAuthUiDistDir(),
      rewriteRequestPath: (path: string) => path.replace(RE_SERVER_AUTH_UI_BASE_PATH, ''),
    }))
    /**
     * Minimal login page for the OIDC Provider flow.
     * When an unauthenticated user hits /api/auth/oauth2/authorize,
     * better-auth redirects here. After the user signs in via a social
     * provider, the social callback redirects to callbackURL which
     * points back to the OIDC authorize endpoint.
     *
     * If a `provider` query parameter is present (e.g. `?provider=github`),
     * skip the picker page and redirect directly to the social provider.
     */
    .on('GET', '/sign-in', (c) => {
      const provider = getOauthProviderHint(c)

      // Reconstruct the OIDC authorize URL from query params so the flow
      // resumes after social login. The oauthProvider plugin appends all
      // authorization request params when redirecting to loginPage.
      const url = new URL(c.req.url)
      const oidcParams = new URLSearchParams(url.searchParams)
      oidcParams.delete('provider')
      // Strip prompt so the post-sign-in redirect to authorize doesn't force
      // another sign-in — prompt=login should only apply on the first pass.
      oidcParams.delete('prompt')

      const callbackURL = oidcParams.toString()
        ? `${deps.env.API_SERVER_URL}/api/auth/oauth2/authorize?${oidcParams.toString()}`
        : '/'

      if (!!provider && ['google', 'github'].includes(provider)) {
        deleteCookie(c, OAUTH_SIGN_IN_PROVIDER_HINT, { path: '/' })
        // better-auth `/sign-in/social` is POST-only; 302 to it from WebView is GET → 404. Bridge with in-page JSON POST.
        return c.html(renderOidcSocialPostBridgeHtml({
          apiServerUrl: deps.env.API_SERVER_URL,
          provider,
          callbackURL,
        }))
      }

      return c.html(renderServerAuthUiHtml({
        apiServerUrl: deps.env.API_SERVER_URL,
        currentUrl: c.req.url,
      }))
    })

    /**
     * Auth routes are handled by the auth instance directly,
     * Powered by better-auth.
     * Rate limited by IP: 20 requests per minute.
     */
    .use('/api/auth/*', rateLimiter({
      max: await deps.configKV.getOrThrow('AUTH_RATE_LIMIT_MAX'),
      windowSec: await deps.configKV.getOrThrow('AUTH_RATE_LIMIT_WINDOW_SEC'),
      keyGenerator: c => c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? 'unknown',
    }))
    .use('/api/auth/oauth2/authorize', async (c, next) => {
      await ensureDynamicFirstPartyRedirectUri(deps.db, c.req.raw)
      const p = c.req.query('provider')
      if (p === 'google' || p === 'github') {
        const isHttps = new URL(c.req.url).protocol === 'https:'
        setCookie(c, OAUTH_SIGN_IN_PROVIDER_HINT, p, {
          path: '/',
          maxAge: 600,
          httpOnly: true,
          sameSite: 'Lax',
          secure: isHttps,
        })
      }
      await next()
    })
    .route('/api/auth', createOIDCTokenAuthRoute(deps))
    /**
     * Electron OIDC callback relay: serves an HTML page that forwards the
     * authorization code to the Electron loopback server via JS fetch().
     * This avoids navigating the browser to http://127.0.0.1:{port}.
     */
    .route('/api/auth/oidc/electron-callback', createElectronCallbackRelay())
    /**
     * OAuth 2.1 Authorization Server metadata must live at the root-level
     * well-known path with the issuer path inserted for non-root issuers.
     */
    .on('GET', '/.well-known/oauth-authorization-server/api/auth', async (c) => {
      return oauthProviderAuthServerMetadata(deps.auth)(c.req.raw)
    })
    /**
     * OpenID Connect discovery metadata uses path appending for issuers with
     * paths, so `/api/auth` serves its own `/.well-known/openid-configuration`.
     */
    .on('GET', '/api/auth/.well-known/openid-configuration', async (c) => {
      return oauthProviderOpenIdConfigMetadata(deps.auth)(c.req.raw)
    })
    .on(['POST', 'GET'], '/api/auth/*', async (c) => {
      return handleAuthRequest(c.req.raw)
    })
}
