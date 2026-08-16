import type Redis from 'ioredis'

import type { PaymentProvider, PaymentService } from '../../payment'
import type { SteamMicroTxnClient, SteamReportOrder } from '../adapters/steam-client'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createSteamPaymentProvider } from '../adapters/steam'
import { createSteamReportWorker, STEAM_REPORT_CURSOR_REDIS_KEY } from './steam-report'

function createRedis(initial?: Record<string, string>): Redis {
  const store = new Map<string, string>(Object.entries(initial ?? {}))
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
  } as unknown as Redis
}

describe('steam report worker', () => {
  let payment: PaymentService
  let steamAdapter: PaymentProvider
  let redis: Redis

  beforeEach(() => {
    payment = {
      applyConfirmation: vi.fn(async () => ({ applied: true, userId: 'user-1', fluxAmount: 500, balanceAfter: 500 })),
      resolvePack: vi.fn(async ref => ref.provider === 'steam' && ref.providerProductId === 1001
        ? { key: 'starter', name: '500 Flux', fluxAmount: 500, recommended: false, providers: { steam: { itemId: 1001 } } }
        : null),
    } as unknown as PaymentService
    steamAdapter = createSteamPaymentProvider()
    redis = createRedis({
      [STEAM_REPORT_CURSOR_REDIS_KEY]: '2026-08-01T00:00:00Z',
    })
  })

  it('credits packs on Succeeded and ignores refund-shaped rows', async () => {
    const orders: SteamReportOrder[] = [
      {
        orderid: '1',
        transid: 't1',
        steamid: '76561198000000001',
        status: 'Succeeded',
        currency: 'USD',
        time: '2026-08-16T10:00:00Z',
        items: [{ itemid: 1001, qty: 1, amount: 499, vat: 0, itemstatus: 'Succeeded' }],
      },
      {
        orderid: '2',
        transid: 't2',
        steamid: '76561198000000001',
        status: 'Refunded',
        currency: 'USD',
        time: '2026-08-16T11:00:00Z',
        items: [{ itemid: 1001, qty: 1, amount: 499, vat: 0, itemstatus: 'Refunded' }],
      },
      {
        orderid: '3',
        transid: 't3',
        steamid: '76561198000000001',
        status: 'Chargedback',
        currency: 'USD',
        time: '2026-08-16T11:30:00Z',
        items: [{ itemid: 1001, qty: 1, amount: 499, vat: 0, itemstatus: 'Chargedback' }],
      },
    ]

    let page = 0
    const client: SteamMicroTxnClient = {
      initTxn: vi.fn(),
      finalizeTxn: vi.fn(),
      getReport: vi.fn(async () => {
        page += 1
        return page === 1 ? { orders } : { orders: [] }
      }),
      getUserAgreementInfo: vi.fn(async () => []),
      cancelAgreement: vi.fn(),
    }

    const worker = createSteamReportWorker({
      client,
      payment,
      steamAdapter,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ userId: 'user-1' }],
            }),
          }),
        }),
      } as never,
      redis,
    })

    const result = await worker.syncOnce()
    expect(result.processed).toBe(3)
    expect(result.appliedPacks).toBe(1)
    expect(result.ignoredRefunds).toBe(2)
    expect(payment.applyConfirmation).toHaveBeenCalledTimes(1)
  })

  it('skips agreement rows until subscription support lands', async () => {
    const orders: SteamReportOrder[] = [{
      orderid: '0',
      transid: 't-plan-1',
      steamid: '76561198000000002',
      status: 'Succeeded',
      currency: 'USD',
      time: '2026-08-16T12:00:00Z',
      agreementid: 'agr-1',
      agreementstatus: 'Active',
      nextpayment: '20260916',
      items: [{ itemid: 2001, qty: 1, amount: 999, vat: 0, itemstatus: 'Succeeded' }],
    }]

    let page = 0
    const client: SteamMicroTxnClient = {
      initTxn: vi.fn(),
      finalizeTxn: vi.fn(),
      getReport: vi.fn(async () => {
        page += 1
        return page === 1 ? { orders } : { orders: [] }
      }),
      getUserAgreementInfo: vi.fn(async () => []),
      cancelAgreement: vi.fn(),
    }

    const worker = createSteamReportWorker({
      client,
      payment,
      steamAdapter,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => [{ userId: 'user-2' }],
            }),
          }),
        }),
      } as never,
      redis,
    })

    const result = await worker.syncOnce()
    expect(result.skipped).toBe(1)
    expect(result.appliedPacks).toBe(0)
    expect(payment.applyConfirmation).not.toHaveBeenCalled()
  })
})
