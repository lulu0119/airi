import type Redis from 'ioredis'

import type { PaymentProvider, PaymentService } from '../../services/domain/payment'
import type { SteamMicroTxnClient, SteamReportOrder } from '../../services/domain/payment/adapters/steam-client'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSteamPaymentProvider } from '../../services/domain/payment'
import { ApiError } from '../../utils/error'
import { createSteamRoutes } from './index'

function createMockPayment(): PaymentService {
  return {
    applyConfirmation: vi.fn(async () => ({ applied: true, userId: 'user-1', fluxAmount: 500, balanceAfter: 500 })),
  } as unknown as PaymentService
}

function createMockClient(orders: SteamReportOrder[] = []): SteamMicroTxnClient {
  return {
    initTxn: vi.fn(),
    finalizeTxn: vi.fn(),
    getReport: vi.fn(async () => ({ orders })),
    getUserAgreementInfo: vi.fn(async () => []),
    cancelAgreement: vi.fn(),
  }
}

function createRedis(): Redis {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
  } as unknown as Redis
}

function createTestApp(deps: {
  payment: PaymentService
  steamAdapter: PaymentProvider
  steamClient: SteamMicroTxnClient | null
  redis: Redis
  reportCronSecret: string | null
}) {
  const routes = createSteamRoutes({
    ...deps,
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    } as never,
  })
  const app = new Hono<HonoEnv>()
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json({
        error: err.errorCode,
        message: err.message,
      }, err.statusCode)
    }
    throw err
  })
  app.route('/', routes)
  return app
}

describe('steam routes', () => {
  let payment: PaymentService
  let steamAdapter: PaymentProvider
  let steamClient: SteamMicroTxnClient
  let redis: Redis

  beforeEach(() => {
    payment = createMockPayment()
    steamAdapter = createSteamPaymentProvider()
    steamClient = createMockClient()
    redis = createRedis()
  })

  it('returns 503 when Steam MicroTxn is not configured', async () => {
    const app = createTestApp({
      payment,
      steamAdapter,
      steamClient: null,
      redis,
      reportCronSecret: 'secret',
    })

    const res = await app.request('/reports/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(503)
  })

  it('returns 401 when the cron secret does not match', async () => {
    const app = createTestApp({
      payment,
      steamAdapter,
      steamClient,
      redis,
      reportCronSecret: 'secret',
    })

    const res = await app.request('/reports/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer wrong',
      },
      body: JSON.stringify({}),
    })

    expect(res.status).toBe(401)
  })

  it('runs GetReport sync with a valid cron bearer', async () => {
    const app = createTestApp({
      payment,
      steamAdapter,
      steamClient,
      redis,
      reportCronSecret: 'secret',
    })

    const res = await app.request('/reports/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer secret',
      },
      body: JSON.stringify({ type: 'SETTLEMENT' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json() as { processed: number, skipped: number }
    expect(body.processed).toBe(0)
    expect(steamClient.getReport).toHaveBeenCalled()
  })
})
