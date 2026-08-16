import type { Database } from '../../../../libs/db'
import type { ConfigKVService } from '../../../adapters/config-kv'
import type { FluxPlan } from '../../payment/types'

import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockDB } from '../../../../libs/mock-db'
import { createTestRedis } from '../../../../libs/tests/redis'
import { createBillingService } from '../../billing/billing-service'
import { createSubscriptionService } from '../index'
import { getMonthlyBounds } from '../monthly-bounds'

import * as schema from '../../../../schemas'

const plusPlan: FluxPlan = {
  key: 'plus',
  name: 'Plus',
  periodQuota: 1000,
  periodMonths: 1,
  recommended: true,
  defaultCurrency: 'usd',
  displayPrices: { usd: '$10.00' },
  providers: { stripe: { priceId: 'price_plus' } },
}

function createConfigKV(): ConfigKVService {
  return {
    getOptional: vi.fn(async (key: string) => {
      if (key === 'FLUX_PLANS')
        return [plusPlan]
      return null
    }),
    getOrThrow: vi.fn(),
    get: vi.fn(),
    refresh: vi.fn(),
    invalidateCache: vi.fn(),
  } as ConfigKVService
}

describe('getMonthlyBounds', () => {
  it('anchors to subscribed day and clamps short months', () => {
    const subscribed = new Date('2024-01-31T08:15:30.000Z')
    const now = new Date('2024-03-15T12:00:00.000Z')
    const { start, end } = getMonthlyBounds(now, subscribed)
    expect(start.toISOString()).toBe('2024-02-29T08:15:30.000Z')
    expect(end.toISOString()).toBe('2024-03-31T08:15:30.000Z')
  })
})

describe('subscription + quota consume', () => {
  let db: Database
  let redis: ReturnType<typeof createTestRedis>
  let clockNow: Date

  beforeAll(async () => {
    db = await mockDB(schema)
    await db.insert(schema.user).values({
      id: 'user-sub-1',
      name: 'Sub User',
      email: 'sub@example.com',
    })
  })

  beforeEach(async () => {
    redis = createTestRedis()
    clockNow = new Date('2024-03-15T12:00:00.000Z')
    await db.delete(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-sub-1'))
    await db.delete(schema.userFlux).where(eq(schema.userFlux.userId, 'user-sub-1'))
    await db.delete(schema.llmRequestLog).where(eq(schema.llmRequestLog.userId, 'user-sub-1'))
    await db.delete(schema.subscription).where(eq(schema.subscription.userId, 'user-sub-1'))
    await db.delete(schema.paymentOrder).where(eq(schema.paymentOrder.userId, 'user-sub-1'))
  })

  function createServices() {
    const configKV = createConfigKV()
    const subscription = createSubscriptionService({
      db,
      clock: () => clockNow,
    })
    const billing = createBillingService(db, redis, configKV, null, subscription)
    return { subscription, billing, configKV }
  }

  it('grants period quota and consumes from quota without writing flux_transaction', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'fake',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 1000,
    })

    const entitlement = await subscription.getEntitlement('user-sub-1')
    expect(entitlement?.periodQuotaRemaining).toBe(1000)

    const result = await billing.consumeFluxForLLM({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-quota-1',
      model: 'gpt-test',
    })

    expect(result.source).toBe('quota')
    expect(result.charged).toBe(5)

    const ledger = await db.query.fluxTransaction.findMany({
      where: eq(schema.fluxTransaction.userId, 'user-sub-1'),
    })
    expect(ledger).toHaveLength(0)

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaRemaining).toBe(995)
  })

  it('hard-stops with quota exhausted when useBalance is false', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'fake',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 3,
    })

    await expect(billing.consumeFluxForLLM({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-block-1',
    })).rejects.toThrow('Monthly Flux quota exhausted')
  })

  it('falls through to balance when useBalance is true', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'fake',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 3,
    })
    await subscription.setUseBalance({ userId: 'user-sub-1', enabled: true })
    await billing.creditFlux({
      userId: 'user-sub-1',
      amount: 50,
      description: 'seed',
      source: 'test',
      requestId: 'seed-1',
    })

    const result = await billing.consumeFluxForLLM({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-balance-1',
      model: 'gpt-test',
    })

    expect(result.source).toBe('balance')
    expect(result.charged).toBe(5)

    const ledger = await db.query.fluxTransaction.findMany({
      where: eq(schema.fluxTransaction.userId, 'user-sub-1'),
    })
    expect(ledger.some(row => row.type === 'debit')).toBe(true)
  })

  it('authorizeFluxSpend allows quota-backed users with empty balance', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'fake',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    const auth = await billing.authorizeFluxSpend({
      userId: 'user-sub-1',
      minimumAmount: 5,
    })
    expect(auth.source).toBe('quota')
  })

  it('endAndReclaim zeroes remaining quota', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'fake',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })
    await subscription.tryConsumeQuota({ userId: 'user-sub-1', amount: 10 })

    const ended = await subscription.endAndReclaim({
      provider: 'fake',
      providerSubscriptionId: 'sub_1',
    })
    expect(ended.ended).toBe(true)
    expect(await subscription.getEntitlement('user-sub-1')).toBeNull()
  })

  it('lazily resets used counter when the monthly window rolls', async () => {
    const { subscription } = createServices()
    const subscribedAt = new Date('2024-01-15T08:00:00.000Z')
    clockNow = new Date('2024-02-20T12:00:00.000Z')

    await db.insert(schema.subscription).values({
      id: 'sub-row-1',
      userId: 'user-sub-1',
      provider: 'fake',
      providerSubscriptionId: 'sub_lazy',
      planKey: 'plus',
      status: 'active',
      periodQuotaAmount: 100,
      periodQuotaUsed: 90,
      periodQuotaUpdatedAt: new Date('2024-01-20T08:00:00.000Z'),
      createdAt: subscribedAt,
      updatedAt: subscribedAt,
    })

    const entitlement = await subscription.getEntitlement('user-sub-1')
    expect(entitlement?.periodQuotaUsed).toBe(0)
    expect(entitlement?.periodQuotaRemaining).toBe(100)
  })
})
