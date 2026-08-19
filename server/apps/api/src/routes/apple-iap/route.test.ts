import type { PaymentProvider, PaymentService } from '../../services/domain/payment'
import type { AppleIapVerifier } from '../../services/domain/payment/adapters/apple-verifier'
import type { HonoEnv } from '../../types/hono'

import { NotificationTypeV2 } from '@apple/app-store-server-library'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createApplePaymentProvider } from '../../services/domain/payment/adapters/apple'
import { ApiError } from '../../utils/error'
import { createAppleIapRoutes } from './index'

function createMockPayment(overrides?: Partial<PaymentService>): PaymentService {
  return {
    resolvePack: vi.fn(async () => ({
      key: 'starter',
      name: '500 Flux',
      fluxAmount: 500,
      recommended: false,
      providers: { appleIap: { productId: 'flux.pack.500' } },
    })),
    applyConfirmation: vi.fn(async () => ({ applied: true, userId: 'user-1', fluxAmount: 500, balanceAfter: 500 })),
    ...overrides,
  } as PaymentService
}

function createMockVerifier(overrides?: Partial<AppleIapVerifier>): AppleIapVerifier {
  return {
    verifyTransaction: vi.fn(async () => ({
      transactionId: 'txn_1',
      originalTransactionId: 'orig_1',
      productId: 'flux.pack.500',
      appAccountToken: 'token',
      type: 'Consumable',
    })),
    verifyNotification: vi.fn(async () => ({
      notificationType: NotificationTypeV2.EXPIRED,
      subtype: undefined,
      notificationUUID: 'uuid-1',
      data: { signedTransactionInfo: 'signed' },
    })),
    ...overrides,
  } as AppleIapVerifier
}

function createTestApp(deps: {
  payment: PaymentService
  appleAdapter: PaymentProvider
  verifier: AppleIapVerifier | null
}) {
  const routes = createAppleIapRoutes(deps)
  const app = new Hono<HonoEnv>()
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({ error: err.errorCode, message: err.message }, err.statusCode)
    }
    throw err
  })
  app.route('/', routes)
  return app
}

describe('apple-iap routes', () => {
  let payment: PaymentService
  let appleAdapter: PaymentProvider
  let verifier: AppleIapVerifier

  beforeEach(() => {
    payment = createMockPayment()
    appleAdapter = createApplePaymentProvider()
    verifier = createMockVerifier()
  })

  it('returns 503 when the verifier is not configured', async () => {
    const app = createTestApp({
      payment,
      appleAdapter,
      verifier: null,
    })

    const res = await app.request('/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedPayload: 'payload' }),
    })

    expect(res.status).toBe(503)
  })

  it('acks EXPIRED notifications without mutating payment state', async () => {
    const app = createTestApp({
      payment,
      appleAdapter,
      verifier,
    })

    const res = await app.request('/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedPayload: 'payload' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true })
    expect(payment.applyConfirmation).not.toHaveBeenCalled()
  })

  it('acks REFUND notifications without applying confirmation', async () => {
    verifier = createMockVerifier({
      verifyNotification: vi.fn(async () => ({
        notificationType: NotificationTypeV2.REFUND,
        subtype: undefined,
        notificationUUID: 'uuid-refund',
        data: {},
      })),
    })
    const app = createTestApp({
      payment,
      appleAdapter,
      verifier,
    })

    const res = await app.request('/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ signedPayload: 'payload' }),
    })

    expect(res.status).toBe(200)
    expect(payment.applyConfirmation).not.toHaveBeenCalled()
  })
})
