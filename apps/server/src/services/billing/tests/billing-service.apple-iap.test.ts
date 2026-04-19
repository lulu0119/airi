import type Redis from 'ioredis'

import type { Database } from '../../../libs/db'
import type { MqService } from '../../../libs/mq'
import type { createConfigKVService } from '../../config-kv'
import type { BillingEvent } from '../billing-events'

import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { mockDB } from '../../../libs/mock-db'
import { DEFAULT_BILLING_EVENTS_STREAM, userFluxRedisKey } from '../../../utils/redis-keys'
import { createBillingService } from '../billing-service'

import * as schema from '../../../schemas'

function createMockConfigKV(): ReturnType<typeof createConfigKVService> {
  return {
    get: vi.fn(async () => undefined),
    getOrThrow: vi.fn(async () => undefined),
    getOptional: vi.fn(async () => null),
    set: vi.fn(),
  } as any
}

function createMockRedis(): Redis {
  const store = new Map<string, string>()
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value)
      return 'OK'
    }),
  } as unknown as Redis
}

function createMockBillingMq(): MqService<BillingEvent> {
  return {
    stream: DEFAULT_BILLING_EVENTS_STREAM,
    publish: vi.fn(async () => '1-0'),
    ensureConsumerGroup: vi.fn(async () => true),
    consume: vi.fn(async () => []),
    claimIdleMessages: vi.fn(async () => []),
    ack: vi.fn(async () => 1),
  } as any
}

describe('billingService — creditFluxFromAppleIapPurchase', () => {
  let db: Database
  let redis: Redis
  let billingMq: MqService<BillingEvent>
  let billingService: ReturnType<typeof createBillingService>

  beforeAll(async () => {
    db = await mockDB(schema)
    await db.insert(schema.user).values({
      id: 'user-apple-iap-1',
      name: 'Apple IAP User',
      email: 'apple-iap@example.com',
    })
  })

  beforeEach(async () => {
    redis = createMockRedis()
    billingMq = createMockBillingMq()
    billingService = createBillingService(db, redis, billingMq, createMockConfigKV())

    await db.delete(schema.fluxTransaction)
    await db.delete(schema.userFlux).where(eq(schema.userFlux.userId, 'user-apple-iap-1'))
    await db.delete(schema.appleIapTransaction).where(eq(schema.appleIapTransaction.userId, 'user-apple-iap-1'))

    await db.insert(schema.appleIapTransaction).values({
      userId: 'user-apple-iap-1',
      transactionId: 'apple-txn-1',
      originalTransactionId: 'apple-txn-1',
      productId: 'flux.pack.1000',
      bundleId: 'ai.moeru.airi-pocket',
      environment: 'Sandbox',
      appAccountToken: '00000000-0000-0000-0000-000000000001',
      purchaseDate: new Date(),
      quantity: 1,
      priceMicros: 1990000,
      currency: 'USD',
      fluxAmount: 1000,
      fluxCredited: false,
    })
  })

  it('credits flux, flips fluxCredited, writes a transaction entry, and publishes two events', async () => {
    const result = await billingService.creditFluxFromAppleIapPurchase({
      userId: 'user-apple-iap-1',
      transactionId: 'apple-txn-1',
      productId: 'flux.pack.1000',
      fluxAmount: 1000,
      priceMicros: 1990000,
      currency: 'USD',
    })

    expect(result).toEqual({ applied: true, balanceAfter: 1000 })

    const [fluxRecord] = await db.select().from(schema.userFlux).where(eq(schema.userFlux.userId, 'user-apple-iap-1'))
    expect(fluxRecord?.flux).toBe(1000)

    const txRecords = await db.select().from(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-apple-iap-1'))
    expect(txRecords).toHaveLength(1)
    expect(txRecords[0]?.type).toBe('credit')
    expect(txRecords[0]?.amount).toBe(1000)
    expect(txRecords[0]?.balanceBefore).toBe(0)
    expect(txRecords[0]?.balanceAfter).toBe(1000)
    expect(txRecords[0]?.requestId).toBe('apple-txn-1')
    expect(txRecords[0]?.metadata).toMatchObject({
      appleTransactionId: 'apple-txn-1',
      productId: 'flux.pack.1000',
      source: 'apple-iap.purchase.completed',
    })

    const [appleRow] = await db.select().from(schema.appleIapTransaction).where(eq(schema.appleIapTransaction.transactionId, 'apple-txn-1'))
    expect(appleRow?.fluxCredited).toBe(true)

    expect(billingMq.publish).toHaveBeenCalledTimes(2)
    expect(billingMq.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'flux.credited' }))
    expect(billingMq.publish).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'apple-iap.purchase.completed' }))

    expect(redis.set).toHaveBeenCalledWith(userFluxRedisKey('user-apple-iap-1'), '1000')
  })

  it('is idempotent — second call on the same transactionId returns applied:false and does not double-credit', async () => {
    await billingService.creditFluxFromAppleIapPurchase({
      userId: 'user-apple-iap-1',
      transactionId: 'apple-txn-1',
      productId: 'flux.pack.1000',
      fluxAmount: 1000,
      priceMicros: 1990000,
      currency: 'USD',
    })

    const second = await billingService.creditFluxFromAppleIapPurchase({
      userId: 'user-apple-iap-1',
      transactionId: 'apple-txn-1',
      productId: 'flux.pack.1000',
      fluxAmount: 1000,
      priceMicros: 1990000,
      currency: 'USD',
    })

    expect(second).toEqual({ applied: false })

    const [fluxRecord] = await db.select().from(schema.userFlux).where(eq(schema.userFlux.userId, 'user-apple-iap-1'))
    expect(fluxRecord?.flux).toBe(1000)

    const txRecords = await db.select().from(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-apple-iap-1'))
    expect(txRecords).toHaveLength(1)

    expect(billingMq.publish).toHaveBeenCalledTimes(2)
  })

  it('uses "?" in description when priceMicros is null to avoid NaN', async () => {
    await db.update(schema.appleIapTransaction)
      .set({ priceMicros: null })
      .where(eq(schema.appleIapTransaction.transactionId, 'apple-txn-1'))

    const result = await billingService.creditFluxFromAppleIapPurchase({
      userId: 'user-apple-iap-1',
      transactionId: 'apple-txn-1',
      productId: 'flux.pack.1000',
      fluxAmount: 1000,
      priceMicros: null,
      currency: 'USD',
    })

    expect(result.applied).toBe(true)

    const [txRecord] = await db.select().from(schema.fluxTransaction).where(eq(schema.fluxTransaction.userId, 'user-apple-iap-1'))
    expect(txRecord?.description).toContain('?')
    expect(txRecord?.description).not.toContain('NaN')
  })
})
