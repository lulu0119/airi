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
    await db.delete(schema.subscriptionQuotaLedger).where(eq(schema.subscriptionQuotaLedger.userId, 'user-sub-1'))
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
      provider: 'stripe',
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

    const quotaLedger = await db.query.subscriptionQuotaLedger.findMany({
      where: eq(schema.subscriptionQuotaLedger.userId, 'user-sub-1'),
    })
    expect(quotaLedger).toHaveLength(1)
    expect(quotaLedger[0]?.amount).toBe(5)
    expect(quotaLedger[0]?.requestId).toBe('req-quota-1')

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaRemaining).toBe(995)
  })

  it('hard-stops with quota exhausted when useBalance is false', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 3,
    })

    await expect(billing.consumeFluxForLLM({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-block-1',
    })).rejects.toMatchObject({ errorCode: 'PAYMENT_REQUIRED' })
  })

  it('falls through to balance when useBalance is true', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
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
      provider: 'stripe',
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
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })
    await subscription.tryConsumeQuota({ userId: 'user-sub-1', amount: 10 })

    const ended = await subscription.endAndReclaim({
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
    })
    expect(ended.ended).toBe(true)
    expect(await subscription.getEntitlement('user-sub-1')).toBeNull()
  })

  it('renews the same provider subscription and resets period quota', async () => {
    const { subscription } = createServices()

    const first = await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })
    expect(first.granted).toBe(true)
    if (!first.granted)
      throw new Error('expected first grant')
    await subscription.tryConsumeQuota({ userId: 'user-sub-1', amount: 25 })

    const renewed = await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    expect(renewed).toEqual({ granted: true, subscriptionId: first.subscriptionId })
    const entitlement = await subscription.getEntitlement('user-sub-1')
    expect(entitlement?.periodQuotaUsed).toBe(0)
    expect(entitlement?.periodQuotaRemaining).toBe(100)
  })

  it('does not grant a second active subscription for a different provider id', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })
    await subscription.tryConsumeQuota({ userId: 'user-sub-1', amount: 10 })

    const duplicate = await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_2',
      planKey: 'plus',
      periodQuotaAmount: 1000,
    })

    expect(duplicate).toEqual({ granted: false })

    const entitlement = await subscription.getEntitlement('user-sub-1')
    expect(entitlement?.periodQuotaUsed).toBe(10)
    expect(entitlement?.periodQuotaRemaining).toBe(90)

    const rows = await db.select().from(schema.subscription).where(eq(schema.subscription.userId, 'user-sub-1'))
    expect(rows.filter(row => row.status === 'active')).toHaveLength(1)
    expect(rows.find(row => row.status === 'active')?.providerSubscriptionId).toBe('sub_1')
  })

  it('grants a new provider subscription after the prior one ends', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })
    await subscription.endAndReclaim({
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
    })

    const next = await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_2',
      planKey: 'plus',
      periodQuotaAmount: 200,
    })

    expect(next).toMatchObject({ granted: true })
    const entitlement = await subscription.getEntitlement('user-sub-1')
    expect(entitlement?.periodQuotaAmount).toBe(200)
    expect(entitlement?.periodQuotaRemaining).toBe(200)
  })

  it('lazily resets used counter when the monthly window rolls', async () => {
    const { subscription } = createServices()
    const subscribedAt = new Date('2024-01-15T08:00:00.000Z')
    clockNow = new Date('2024-02-20T12:00:00.000Z')

    await db.insert(schema.subscription).values({
      id: 'sub-row-1',
      userId: 'user-sub-1',
      provider: 'stripe',
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

  // ROOT CAUSE:
  //
  // If two consumes run at the same time, the used counter can lose one of them.
  // This happens because tryConsumeQuota did SELECT ... FOR UPDATE and then a
  // separate UPDATE. Callers do not pass a transaction, so Postgres releases
  // the row lock when the SELECT statement ends. Both calls can read the same
  // periodQuotaUsed and the last UPDATE overwrites the first.
  //
  // Before: two concurrent consumes of 5 could leave used at 5.
  // After: the module opens a short transaction, inserts the ledger row first,
  // then runs one atomic CASE UPDATE. Final used is the sum (10). Callers still
  // omit tx; the module owns the transaction.
  it('charges the sum when two concurrent consumes use different request ids', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    const [first, second] = await Promise.all([
      subscription.tryConsumeQuota({ userId: 'user-sub-1', amount: 5, requestId: 'req-concurrent-a' }),
      subscription.tryConsumeQuota({ userId: 'user-sub-1', amount: 5, requestId: 'req-concurrent-b' }),
    ])

    expect(first).not.toBeNull()
    expect(second).not.toBeNull()

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaUsed).toBe(10)
    expect(after?.periodQuotaRemaining).toBe(90)
  })

  it('replays request A after B without charging A a second time', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    const firstA = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-a',
    })
    const firstB = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 7,
      requestId: 'req-b',
    })
    const replayA = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-a',
    })

    expect(firstA?.charged).toBe(5)
    expect(firstB?.charged).toBe(7)
    expect(replayA?.charged).toBe(5)

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaUsed).toBe(12)

    const rows = await db.query.subscriptionQuotaLedger.findMany({
      where: eq(schema.subscriptionQuotaLedger.userId, 'user-sub-1'),
    })
    expect(rows).toHaveLength(2)
  })

  it('replays the first amount when the same request id is sent with a different amount', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    const first = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-same',
    })
    const replay = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 20,
      requestId: 'req-same',
    })

    expect(first?.charged).toBe(5)
    expect(replay?.charged).toBe(5)

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaUsed).toBe(5)
  })

  it('resets and charges in one update when the monthly window has expired', async () => {
    const { subscription } = createServices()
    const subscribedAt = new Date('2024-01-15T08:00:00.000Z')
    clockNow = new Date('2024-02-20T12:00:00.000Z')

    await db.insert(schema.subscription).values({
      id: 'sub-window-1',
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_window',
      planKey: 'plus',
      status: 'active',
      periodQuotaAmount: 100,
      periodQuotaUsed: 90,
      periodQuotaUpdatedAt: new Date('2024-01-20T08:00:00.000Z'),
      createdAt: subscribedAt,
      updatedAt: subscribedAt,
    })

    const charged = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 10,
      requestId: 'req-window',
    })

    expect(charged?.charged).toBe(10)
    expect(charged?.remaining).toBe(90)

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaUsed).toBe(10)
    expect(after?.periodQuotaRemaining).toBe(90)
  })

  it('returns null and writes no ledger row when quota is insufficient', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    const result = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 1000,
      requestId: 'req-too-big',
    })

    expect(result).toBeNull()

    const rows = await db.query.subscriptionQuotaLedger.findMany({
      where: eq(schema.subscriptionQuotaLedger.userId, 'user-sub-1'),
    })
    expect(rows).toHaveLength(0)

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaUsed).toBe(0)
  })

  // ROOT CAUSE:
  // Window-expired UPDATE used `updatedAt < windowStart OR used + amount <= cap`.
  // The first branch let any amount through and SET wrote used = amount.
  // After: SET/WHERE share effectiveUsed so over-cap returns null and rolls back.
  it('rejects an over-cap consume after the monthly window has expired', async () => {
    const { subscription } = createServices()
    const subscribedAt = new Date('2024-01-15T08:00:00.000Z')
    clockNow = new Date('2024-02-20T12:00:00.000Z')

    await db.insert(schema.subscription).values({
      id: 'sub-window-overcap',
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_window_overcap',
      planKey: 'plus',
      status: 'active',
      periodQuotaAmount: 100,
      periodQuotaUsed: 90,
      periodQuotaUpdatedAt: new Date('2024-01-20T08:00:00.000Z'),
      createdAt: subscribedAt,
      updatedAt: subscribedAt,
    })

    const result = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 150,
      requestId: 'req-window-overcap',
    })

    expect(result).toBeNull()

    const rows = await db.query.subscriptionQuotaLedger.findMany({
      where: eq(schema.subscriptionQuotaLedger.userId, 'user-sub-1'),
    })
    expect(rows).toHaveLength(0)

    const entitlement = await subscription.getEntitlement('user-sub-1')
    expect(entitlement?.periodQuotaUsed).toBe(0)
    expect(entitlement?.periodQuotaRemaining).toBe(100)

    const [row] = await db.select().from(schema.subscription).where(eq(schema.subscription.id, 'sub-window-overcap'))
    expect(row?.periodQuotaUsed).toBe(90)
    expect(row?.periodQuotaUpdatedAt).toEqual(new Date('2024-01-20T08:00:00.000Z'))
  })

  it('writes a ledger row when the caller omits requestId', async () => {
    const { subscription } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 100,
    })

    const result = await subscription.tryConsumeQuota({
      userId: 'user-sub-1',
      amount: 4,
    })

    expect(result?.charged).toBe(4)

    const rows = await db.query.subscriptionQuotaLedger.findMany({
      where: eq(schema.subscriptionQuotaLedger.userId, 'user-sub-1'),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.requestId).toBeNull()
    expect(rows[0]?.amount).toBe(4)
  })

  it('replays quota after the window is exhausted so billing does not 402', async () => {
    const { subscription, billing } = createServices()

    await subscription.grantPeriod({
      userId: 'user-sub-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_1',
      planKey: 'plus',
      periodQuotaAmount: 5,
    })

    const first = await billing.consumeFluxForLLM({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-last-unit',
    })
    expect(first.source).toBe('quota')
    expect(first.charged).toBe(5)

    const replay = await billing.consumeFluxForLLM({
      userId: 'user-sub-1',
      amount: 5,
      requestId: 'req-last-unit',
    })
    expect(replay.source).toBe('quota')
    expect(replay.charged).toBe(5)

    const after = await subscription.getEntitlement('user-sub-1')
    expect(after?.periodQuotaUsed).toBe(5)
  })
})
