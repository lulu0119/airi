import type { AppType } from '../../../../apps/server/src/app'

import { hc } from 'hono/client'

import { getAuthToken } from '../libs/auth'
import { applyNgrokSkipRequestHeader, SERVER_URL } from '../libs/server'

export const client = hc<AppType>(SERVER_URL, {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    applyNgrokSkipRequestHeader(headers)
    const token = getAuthToken()
    if (token) {
      headers.set('Authorization', `Bearer ${token}`)
    }
    return fetch(input, {
      ...init,
      headers,
      credentials: 'omit',
    })
  },
})
