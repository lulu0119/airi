import type { Database } from '../../../../libs/db'
import type { ConfigKVService } from '../../../adapters/config-kv'
import type { FluxPack, FluxPlan, PaymentProvider, ProviderCreateInput } from '../types'

import { and, eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockDB } from '../../../../libs/mock-db'
import { createTestRedis } from '../../../../libs/tests/redis'
import { userFluxRedisKey } from '../../../../utils/redis-keys'
import { createBillingService } from '../../billing/billing-service'
import { createSubscriptionService } from '../../subscription'
import { createPaymentService } from '../index'

import * as schema from '../../../../schemas'

const starterPack: FluxPack = {
  key: 'starter',
  name: '500 Flux',
  fluxAmount: 500,
  recommended: false,
  providers: { stripe: { priceId: 'price_starter' }, appleIap: { productId: 'flux.pack.500' }, steam: { itemId: 1001 } },
}

const plusPlan: FluxPlan = {
  key: 'plus',
  name: 'Plus',
  periodQuota: 1000,
  periodMonths: 1,
  recommended: false,
  defaultCurrency: 'usd',
  displayPrices: { usd: '$9.99' },
  providers: { stripe: { priceId: 'price_plus' } },
}

function createTestPaymentProvider(options?: {
  onCreate?: (input: ProviderCreateInput) => Promise<void> | void
}): PaymentProvider {
  return {
    async create(input) {
      await options?.onCreate?.(input)
      return {
        providerOrderId: `cs_test_${input.paymentOrderId}`,
        url: `https://checkout.stripe.test/${input.paymentOrderId}`,
      }
    },
    async listPackages(packs) {
      return packs.map(pack => ({
        packKey: pack.key,
        stripePriceId: pack.providers.stripe?.priceId,
        label: pack.name,
        defaultCurrency: 'usd',
        currencies: { usd: '$5.00' },
        recommended: pack.recommended,
      }))
    },
    confirmed() {
      throw new Error('test adapter does not map native payloads')
    },
    async cancel() {},
    async getStatus() {
      return null
    },
  }
}

function createPacksConfigKV(initial: FluxPack[]): ConfigKVService & { setPacks: (packs: FluxPack[]) => void } {
  let packs = initial
  return {
    getOptional: vi.fn(async (key: string) => {
      if (key === 'FLUX_PACKS')
        return packs
      if (key === 'FLUX_PLANS')
        return [plusPlan]
      return null
    }),
    getOrThrow: vi.fn(),
    get: vi.fn(),
    refresh: vi.fn(),
    invalidateCache: vi.fn(),
    setPacks(next: FluxPack[]) {
      packs = next
    },
  } as ConfigKVService & { setPacks: (packs: FluxPack[]) => void }
}

describe('payment CORE', () => {
  let db: Database
  let redis: ReturnType<typeof createTestRedis>
  let configKV: ReturnType<typeof createPacksConfigKV>
  let payment: ReturnType<typeof createPaymentService>
  let subscription: ReturnType<typeof createSubscriptionService>
  let createCalls: ProviderCreateInput[]
  let applyDuringCreate: boolean

  beforeAll(async () => {
    db = await mockDB(schema)
    await db.insert(schema.user).values({
      id: 'user-pay-1',
      name: 'Pay User',
      email: 'pay@example.com',
    })
  })

  beforeEach(async () => {
    redis = createTestRedis()
    configKV = createPacksConfigKV([starterPack])
    applyDuringCreate = false
    createCalls = []
    const billing = createBillingService(db, redis, configKV)
    subscription = createSubscriptionService({ db })

    let service: ReturnType<typeof createPaymentService>
    const stripe = createTestPaymentProvider({
      onCreate: async (input) => {
        createCalls.push(input)
        if (!applyDuringCreate)
          return
        if (input.kind !== 'pack')
          return
        await service.applyConfirmation({
          provider: 'stripe',
          paymentOrderId: input.paymentOrderId,
          providerOrderId: `cs_test_${input.paymentOrderId}`,
          status: 'paid',
          amount: 500,
          currency: 'usd',
          providerCustomerId: 'cus_test',
        })
      },
    })

    service = createPaymentService({
      db,
      billing,
      configKV,
      subscription,
      providers: { stripe },
    })
    payment = service

    await db.delete(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-pay-1'))
    await db.delete(schema.userFlux).where(eq(schema.userFlux.userId, 'user-pay-1'))
    await db.delete(schema.paymentOrder).where(eq(schema.paymentOrder.userId, 'user-pay-1'))
    await db.delete(schema.providerAccount).where(eq(schema.providerAccount.userId, 'user-pay-1'))
    await db.delete(schema.subscriptionQuotaLedger).where(eq(schema.subscriptionQuotaLedger.userId, 'user-pay-1'))
    await db.delete(schema.subscription).where(eq(schema.subscription.userId, 'user-pay-1'))
  })

  async function startStarterPack() {
    return payment.startPack({
      userId: 'user-pay-1',
      provider: 'stripe',
      packKey: 'starter',
      startContext: {
        currency: 'usd',
        successUrl: 'https://example.test/success',
        cancelUrl: 'https://example.test/cancel',
        customerEmail: 'pay@example.com',
      },
    })
  }

  async function startPlusPlan() {
    return payment.startPlan({
      userId: 'user-pay-1',
      provider: 'stripe',
      planKey: 'plus',
      startContext: {
        currency: 'usd',
        successUrl: 'https://example.test/success',
        cancelUrl: 'https://example.test/cancel',
        customerEmail: 'pay@example.com',
      },
    })
  }

  it('startPack snapshots the pack and applyConfirmation credits Flux', async () => {
    const started = await startStarterPack()
    expect(started.kind).toBe('redirect')
    expect(started.url).toContain('checkout.stripe.test')

    const result = await payment.applyConfirmation({
      provider: 'stripe',
      paymentOrderId: started.paymentOrderId,
      providerOrderId: `cs_test_${started.paymentOrderId}`,
      status: 'paid',
      amount: 500,
      currency: 'usd',
      providerCustomerId: 'cus_test',
    })

    expect(result).toMatchObject({ applied: true, fluxAmount: 500, balanceAfter: 500 })

    const [flux] = await db.select().from(schema.userFlux).where(eq(schema.userFlux.userId, 'user-pay-1'))
    expect(flux?.flux).toBe(500)

    const [ledger] = await db.select().from(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-pay-1'))
    expect(ledger?.amount).toBe(500)
    expect(ledger?.requestId).toBe(started.paymentOrderId)

    const [order] = await db.select().from(schema.paymentOrder).where(eq(schema.paymentOrder.id, started.paymentOrderId))
    expect(order?.status).toBe('paid')
    expect(order?.creditedAt).toBeInstanceOf(Date)
    expect(order?.packKey).toBe('starter')
    expect(order?.fluxAmount).toBe(500)

    expect(await redis.get(userFluxRedisKey('user-pay-1'))).toBe('500')
  })

  it('listPacks returns platform price items through the provider', async () => {
    const items = await payment.listPacks('stripe')
    expect(items).toEqual([{
      packKey: 'starter',
      stripePriceId: 'price_starter',
      label: '500 Flux',
      defaultCurrency: 'usd',
      currencies: { usd: '$5.00' },
      recommended: false,
    }])
  })

  it('resolvePack finds a pack by Stripe price id', async () => {
    await expect(payment.resolvePack({ provider: 'stripe', providerProductId: 'price_starter' }))
      .resolves
      .toMatchObject({ key: 'starter', fluxAmount: 500 })
    await expect(payment.resolvePack({ provider: 'stripe', providerProductId: 'price_unknown' }))
      .resolves
      .toBeNull()
  })

  it('resolvePlan finds a plan by Stripe price id', async () => {
    await expect(payment.resolvePlan({ provider: 'stripe', providerProductId: 'price_plus' }))
      .resolves
      .toMatchObject({ key: 'plus', periodQuota: 1000 })
    await expect(payment.resolvePlan({ provider: 'stripe', providerProductId: 'price_unknown' }))
      .resolves
      .toBeNull()
  })

  it('applyConfirmation replay returns applied false and does not double credit', async () => {
    const started = await startStarterPack()
    const facts = {
      provider: 'stripe' as const,
      paymentOrderId: started.paymentOrderId,
      providerOrderId: `cs_test_${started.paymentOrderId}`,
      status: 'paid' as const,
    }

    const first = await payment.applyConfirmation(facts)
    const second = await payment.applyConfirmation(facts)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)

    const ledger = await db.select().from(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-pay-1'))
    expect(ledger).toHaveLength(1)

    const [flux] = await db.select().from(schema.userFlux).where(eq(schema.userFlux.userId, 'user-pay-1'))
    expect(flux?.flux).toBe(500)
  })

  it('credits the snapshot when FLUX_PACKS changes after startPack', async () => {
    const started = await startStarterPack()
    configKV.setPacks([{ ...starterPack, fluxAmount: 9999 }])

    const result = await payment.applyConfirmation({
      provider: 'stripe',
      paymentOrderId: started.paymentOrderId,
      providerOrderId: `cs_test_${started.paymentOrderId}`,
      status: 'paid',
    })

    expect(result).toMatchObject({ applied: true, fluxAmount: 500 })

    const [flux] = await db.select().from(schema.userFlux).where(eq(schema.userFlux.userId, 'user-pay-1'))
    expect(flux?.flux).toBe(500)
  })

  it('accepts webhook-before-checkout when the order exists and create has not returned', async () => {
    applyDuringCreate = true
    const started = await startStarterPack()

    expect(started.kind).toBe('redirect')

    const [flux] = await db.select().from(schema.userFlux).where(eq(schema.userFlux.userId, 'user-pay-1'))
    expect(flux?.flux).toBe(500)

    const [order] = await db.select().from(schema.paymentOrder).where(eq(schema.paymentOrder.id, started.paymentOrderId))
    expect(order?.status).toBe('paid')
    expect(order?.providerOrderId).toBe(`cs_test_${started.paymentOrderId}`)
  })

  it('throws when applyConfirmation runs before the order exists so the channel can retry', async () => {
    await expect(payment.applyConfirmation({
      provider: 'stripe',
      paymentOrderId: 'missing-order',
      providerOrderId: 'cs_test_missing',
      status: 'paid',
    })).rejects.toMatchObject({
      statusCode: 500,
    })
  })

  it('resolvePack finds a pack by Apple product id', async () => {
    await expect(payment.resolvePack({ provider: 'apple_iap', providerProductId: 'flux.pack.500' }))
      .resolves
      .toMatchObject({ key: 'starter', fluxAmount: 500 })
  })

  it('resolvePack finds a pack by Steam item id', async () => {
    await expect(payment.resolvePack({ provider: 'steam', providerProductId: 1001 }))
      .resolves
      .toMatchObject({ key: 'starter', fluxAmount: 500 })
  })

  it('evidence-first applyConfirmation inserts paid order and credits Flux', async () => {
    const result = await payment.applyConfirmation({
      provider: 'apple_iap',
      providerOrderId: 'apple_txn_1',
      status: 'paid',
      userId: 'user-pay-1',
      packKey: 'starter',
      fluxAmount: 500,
      amount: 4990000,
      currency: 'USD',
      providerCustomerId: 'app-account-token-1',
    })

    expect(result).toMatchObject({ applied: true, fluxAmount: 500, balanceAfter: 500 })

    const [order] = await db.select().from(schema.paymentOrder).where(and(
      eq(schema.paymentOrder.provider, 'apple_iap'),
      eq(schema.paymentOrder.providerOrderId, 'apple_txn_1'),
    ))
    expect(order?.status).toBe('paid')
    expect(order?.packKey).toBe('starter')
    expect(order?.fluxAmount).toBe(500)
    expect(order?.creditedAt).toBeInstanceOf(Date)

    const [account] = await db.select().from(schema.providerAccount).where(eq(schema.providerAccount.userId, 'user-pay-1'))
    expect(account?.provider).toBe('apple_iap')
    expect(account?.providerCustomerId).toBe('app-account-token-1')
  })

  it('evidence-first applyConfirmation replay returns applied false', async () => {
    const facts = {
      provider: 'apple_iap' as const,
      providerOrderId: 'apple_txn_replay',
      status: 'paid' as const,
      userId: 'user-pay-1',
      packKey: 'starter',
      fluxAmount: 500,
    }

    const first = await payment.applyConfirmation(facts)
    const second = await payment.applyConfirmation(facts)

    expect(first.applied).toBe(true)
    expect(second.applied).toBe(false)

    const ledger = await db.select().from(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-pay-1'))
    expect(ledger).toHaveLength(1)
  })

  it('startPlan redirects when the user has no active subscription', async () => {
    const started = await startPlusPlan()
    expect(started.kind).toBe('redirect')
    expect(started.url).toContain('checkout.stripe.test')
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.kind).toBe('plan')

    const orders = await db.select().from(schema.paymentOrder).where(eq(schema.paymentOrder.userId, 'user-pay-1'))
    expect(orders).toHaveLength(1)
    expect(orders[0]?.planKey).toBe('plus')
  })

  it('startPlan returns 409 when the user already has an active subscription', async () => {
    await subscription.grantPeriod({
      userId: 'user-pay-1',
      provider: 'stripe',
      providerSubscriptionId: 'sub_existing',
      planKey: 'plus',
      periodQuotaAmount: 1000,
    })

    await expect(startPlusPlan()).rejects.toMatchObject({
      statusCode: 409,
      errorCode: 'ALREADY_SUBSCRIBED',
    })

    expect(createCalls).toHaveLength(0)
    const orders = await db.select().from(schema.paymentOrder).where(eq(schema.paymentOrder.userId, 'user-pay-1'))
    expect(orders).toHaveLength(0)
  })

  it('applyPlanInvoice does not apply a second paid subscription for the same user', async () => {
    const first = await payment.applyPlanInvoice({
      provider: 'stripe',
      providerInvoiceId: 'in_first',
      providerSubscriptionId: 'sub_first',
      userId: 'user-pay-1',
      planKey: 'plus',
      periodQuota: 1000,
      amount: 999,
      currency: 'usd',
    })
    expect(first).toMatchObject({ applied: true, periodQuota: 1000 })

    await subscription.tryConsumeQuota({ userId: 'user-pay-1', amount: 40 })

    const second = await payment.applyPlanInvoice({
      provider: 'stripe',
      providerInvoiceId: 'in_second',
      providerSubscriptionId: 'sub_second',
      userId: 'user-pay-1',
      planKey: 'plus',
      periodQuota: 1000,
      amount: 999,
      currency: 'usd',
    })
    expect(second).toEqual({ applied: false })

    const entitlement = await subscription.getEntitlement('user-pay-1')
    expect(entitlement?.periodQuotaUsed).toBe(40)
    expect(entitlement?.periodQuotaRemaining).toBe(960)

    const orders = await db.select().from(schema.paymentOrder).where(eq(schema.paymentOrder.userId, 'user-pay-1'))
    expect(orders).toHaveLength(1)
    expect(orders[0]?.providerOrderId).toBe('in_first')
    expect(orders[0]?.status).toBe('paid')
  })
})
