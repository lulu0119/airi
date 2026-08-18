import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'

import { mockDB } from '../../libs/mock-db'
import { createFluxTransactionService } from './flux-transaction'

import * as schema from '../../schemas'

describe('fluxTransactionService', () => {
  let db: any
  let service: ReturnType<typeof createFluxTransactionService>

  beforeAll(async () => {
    db = await mockDB(schema)
    await db.insert(schema.user).values({
      id: 'user-tx',
      name: 'Transaction User',
      email: 'tx@example.com',
    })
    service = createFluxTransactionService(db)
  })

  it('log should insert a single transaction entry', async () => {
    await service.log({
      userId: 'user-tx',
      type: 'credit',
      amount: 500,
      balanceBefore: 0,
      balanceAfter: 500,
      description: 'Stripe payment',
      metadata: { stripeSessionId: 'sess_123' },
    })

    const { records } = await service.getHistory('user-tx', 10, 0)
    expect(records).toHaveLength(1)
    expect(records[0].type).toBe('credit')
    expect(records[0].amount).toBe(500)
  })

  it('logBatch should insert multiple entries', async () => {
    await service.logBatch([
      { userId: 'user-tx', type: 'debit', amount: 10, balanceBefore: 500, balanceAfter: 490, description: 'gpt-4o' },
      { userId: 'user-tx', type: 'debit', amount: 5, balanceBefore: 490, balanceAfter: 485, description: 'gpt-4o-mini' },
    ])

    const { records } = await service.getHistory('user-tx', 10, 0)
    expect(records).toHaveLength(3) // 1 from previous test + 2 batch
  })

  it('logBatch with empty array should be a no-op', async () => {
    await service.logBatch([])
    const { records } = await service.getHistory('user-tx', 10, 0)
    expect(records).toHaveLength(3)
  })

  it('getHistory should paginate correctly with hasMore', async () => {
    const { records, hasMore } = await service.getHistory('user-tx', 2, 0)
    expect(records).toHaveLength(2)
    expect(hasMore).toBe(true)
  })

  it('getHistory should return hasMore=false on last page', async () => {
    const { records, hasMore } = await service.getHistory('user-tx', 10, 0)
    expect(records).toHaveLength(3)
    expect(hasMore).toBe(false)
  })

  it('getHistory should respect offset', async () => {
    const { records } = await service.getHistory('user-tx', 10, 2)
    expect(records).toHaveLength(1)
  })

  it('getHistory should return records ordered by createdAt desc', async () => {
    const { records } = await service.getHistory('user-tx', 10, 0)
    for (let i = 1; i < records.length; i++) {
      expect(new Date(records[i - 1].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(records[i].createdAt).getTime())
    }
  })

  it('getHistory reads quota rows from subscription_quota_ledger even when llm_request_log is empty', async () => {
    await db.insert(schema.subscriptionQuotaLedger).values({
      userId: 'user-tx',
      subscriptionId: 'sub-history-1',
      requestId: 'req-quota-history',
      amount: 12,
    })

    const { records } = await service.getHistory('user-tx', 20, 0)
    const quotaRows = records.filter(row => row.billingSource === 'quota')
    expect(quotaRows).toHaveLength(1)
    expect(quotaRows[0]?.type).toBe('debit')
    expect(quotaRows[0]?.amount).toBe(12)
    expect(quotaRows[0]?.description).toBe('quota')

    const logs = await db.select().from(schema.llmRequestLog).where(eq(schema.llmRequestLog.userId, 'user-tx'))
    expect(logs).toHaveLength(0)
  })
})
