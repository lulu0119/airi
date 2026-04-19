import type { AppleIapService } from '../../services/apple-iap/service'
import type { AppleIapVerifier } from '../../services/apple-iap/verifier'
import type { BillingService } from '../../services/billing/billing-service'
import type { ConfigKVService } from '../../services/config-kv'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { v5 as uuidv5 } from 'uuid'
import { describe, expect, it, vi } from 'vitest'

import { createAppleIapRoutes } from '.'
import { APPLE_IAP_NAMESPACE_UUID } from '../../utils/apple-iap'
import { ApiError, createBadRequestError } from '../../utils/error'

// --- Fixtures ---

const testUser = { id: 'user-apple-1', name: 'Test User', email: 'apple@example.com' }
const validAppAccountToken = uuidv5(testUser.id, APPLE_IAP_NAMESPACE_UUID)
const validBundleId = 'ai.moeru.airi-pocket'

function basePayload() {
  return {
    transactionId: 'txn-1',
    originalTransactionId: 'txn-1',
    productId: 'flux.pack.1000',
    bundleId: validBundleId,
    environment: 'Sandbox',
    appAccountToken: validAppAccountToken,
    purchaseDate: Date.now(),
    quantity: 1,
    price: 1990000,
    currency: 'USD',
  }
}

// --- Mock helpers ---

function createMockAppleIapService(): AppleIapService {
  return {
    upsertTransaction: vi.fn(async data => ({
      id: 'row-1',
      fluxCredited: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    })),
    getByTransactionId: vi.fn(async () => undefined),
  } as any
}

function createMockVerifier(resultOrError: object | Error): AppleIapVerifier {
  return {
    verifyTransaction: vi.fn(async () => {
      if (resultOrError instanceof Error)
        throw resultOrError
      return resultOrError
    }),
  } as any
}

function createMockBillingService(overrides: Partial<BillingService> = {}): BillingService {
  return {
    creditFluxFromAppleIapPurchase: vi.fn(async () => ({ applied: true, balanceAfter: 1500 })),
    ...overrides,
  } as any
}

function createMockConfigKV(overrides: Record<string, any> = {}): ConfigKVService {
  const defaults: Record<string, any> = {
    APPLE_IAP_PRODUCTS: [
      { productId: 'flux.pack.1000', fluxAmount: 1000, label: '1000 Flux' },
      { productId: 'flux.pack.3000', fluxAmount: 3000, label: '3000 Flux', recommended: true },
    ],
    ...overrides,
  }
  return {
    getOrThrow: vi.fn(async (key: string) => {
      if (defaults[key] === undefined)
        throw new Error(`Config key "${key}" is not set`)
      return defaults[key]
    }),
    getOptional: vi.fn(async (key: string) => defaults[key] ?? null),
    get: vi.fn(async (key: string) => defaults[key]),
    set: vi.fn(),
  } as any
}

function createTestApp(
  verifier: AppleIapVerifier,
  billingService: BillingService = createMockBillingService(),
  appleIapService: AppleIapService = createMockAppleIapService(),
  configKV: ConfigKVService = createMockConfigKV(),
) {
  const routes = createAppleIapRoutes(appleIapService, verifier, billingService, configKV)
  const app = new Hono<HonoEnv>()

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({
        error: err.errorCode,
        message: err.message,
        details: err.details,
      }, err.statusCode)
    }
    return c.json({ error: 'Internal Server Error', message: err.message }, 500)
  })

  // Mirror sessionMiddleware: pull user out of env for test convenience.
  app.use('*', async (c, next) => {
    const user = (c.env as any)?.user
    if (user) {
      c.set('user', user)
    }
    await next()
  })

  app.route('/api/v1/apple-iap', routes)
  return { app, billingService, appleIapService, configKV }
}

async function postTransaction(app: Hono<HonoEnv>, body: unknown) {
  return app.fetch(
    new Request('http://localhost/api/v1/apple-iap/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { user: testUser } as any,
  )
}

// --- Tests ---

/**
 * @example
 * describe('GET /api/v1/apple-iap/packages', () => {
 *   // returns empty array when APPLE_IAP_PRODUCTS is unset or empty
 *   // returns the configKV catalog as-is
 * })
 */
describe('appleIapRoutes — gET /packages', () => {
  it('returns empty array when catalog is unset', async () => {
    const { app } = createTestApp(
      createMockVerifier(basePayload()),
      createMockBillingService(),
      createMockAppleIapService(),
      createMockConfigKV({ APPLE_IAP_PRODUCTS: null }),
    )

    const res = await app.request('/api/v1/apple-iap/packages')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it('returns the configured catalog', async () => {
    const { app } = createTestApp(createMockVerifier(basePayload()))

    const res = await app.request('/api/v1/apple-iap/packages')
    expect(res.status).toBe(200)

    const data = await res.json() as Array<{ productId: string, fluxAmount: number, recommended?: boolean }>
    expect(data).toHaveLength(2)
    expect(data[0].productId).toBe('flux.pack.1000')
    expect(data[1].recommended).toBe(true)
  })
})

describe('appleIapRoutes — pOST /transactions', () => {
  it('returns 401 when unauthenticated', async () => {
    const routes = createAppleIapRoutes(
      createMockAppleIapService(),
      createMockVerifier(basePayload()),
      createMockBillingService(),
      createMockConfigKV(),
    )
    const app = new Hono<HonoEnv>()
    app.onError((err, c) => {
      if (err instanceof ApiError)
        return c.json({ error: err.errorCode }, err.statusCode)
      return c.json({ error: 'ISE' }, 500)
    })
    app.route('/api/v1/apple-iap', routes)

    const res = await app.request('/api/v1/apple-iap/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedTransaction: 'jws' }),
    })
    expect(res.status).toBe(401)
  })

  it('returns 400 when signedTransaction is missing', async () => {
    const { app } = createTestApp(createMockVerifier(basePayload()))

    const res = await postTransaction(app, {})
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('INVALID_REQUEST')
  })

  it('returns 400 when the verifier rejects the JWS signature', async () => {
    const verifier = createMockVerifier(createBadRequestError('Signed transaction failed verification', 'JWS_VERIFICATION_FAILED'))
    const { app } = createTestApp(verifier)

    const res = await postTransaction(app, { signedTransaction: 'bogus.jws.string' })
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('JWS_VERIFICATION_FAILED')
  })

  it('returns 400 when bundleId in payload does not match', async () => {
    const verifier = createMockVerifier(createBadRequestError('Bundle identifier mismatch', 'BUNDLE_MISMATCH', {
      expected: validBundleId,
      actual: 'other.bundle',
    }))
    const { app } = createTestApp(verifier)

    const res = await postTransaction(app, { signedTransaction: 'jws' })
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('BUNDLE_MISMATCH')
  })

  it('returns 403 when appAccountToken does not match authenticated user', async () => {
    const payload = basePayload()
    payload.appAccountToken = uuidv5('another-user', APPLE_IAP_NAMESPACE_UUID)
    const { app, billingService } = createTestApp(createMockVerifier(payload))

    const res = await postTransaction(app, { signedTransaction: 'jws' })
    expect(res.status).toBe(403)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('ACCOUNT_TOKEN_MISMATCH')
    expect(billingService.creditFluxFromAppleIapPurchase).not.toHaveBeenCalled()
  })

  it('returns 400 when productId is not in the configured catalog', async () => {
    const payload = basePayload()
    payload.productId = 'flux.pack.unknown'
    const { app } = createTestApp(createMockVerifier(payload))

    const res = await postTransaction(app, { signedTransaction: 'jws' })
    expect(res.status).toBe(400)
    const data = await res.json() as { error: string }
    expect(data.error).toBe('UNKNOWN_PRODUCT')
  })

  it('credits flux on valid first purchase and returns applied:true', async () => {
    const billingService = createMockBillingService()
    const appleIapService = createMockAppleIapService()
    const { app } = createTestApp(
      createMockVerifier(basePayload()),
      billingService,
      appleIapService,
    )

    const res = await postTransaction(app, { signedTransaction: 'jws' })
    expect(res.status).toBe(200)

    const data = await res.json() as { applied: boolean, balanceAfter: number, transactionId: string }
    expect(data.applied).toBe(true)
    expect(data.balanceAfter).toBe(1500)
    expect(data.transactionId).toBe('txn-1')

    expect(appleIapService.upsertTransaction).toHaveBeenCalledTimes(1)
    expect(billingService.creditFluxFromAppleIapPurchase).toHaveBeenCalledWith({
      userId: testUser.id,
      transactionId: 'txn-1',
      productId: 'flux.pack.1000',
      fluxAmount: 1000,
      priceMicros: 1990000,
      currency: 'USD',
    })
  })

  it('is idempotent — returns applied:false on replayed transactionId', async () => {
    const billingService = createMockBillingService({
      creditFluxFromAppleIapPurchase: vi.fn(async () => ({ applied: false })),
    } as any)
    const { app } = createTestApp(createMockVerifier(basePayload()), billingService)

    const res = await postTransaction(app, { signedTransaction: 'jws' })
    expect(res.status).toBe(200)

    const data = await res.json() as { applied: boolean, balanceAfter?: number }
    expect(data.applied).toBe(false)
    expect(data.balanceAfter).toBeUndefined()
  })
})
