import type { Database } from '../../../libs/db'
import type { Clock } from './monthly-bounds'

import { and, eq, isNull, sql } from 'drizzle-orm'

import { createForbiddenError, createInternalError, createNotFoundError } from '../../../utils/error'
import { getMonthlyBounds, systemClock } from './monthly-bounds'

import * as schema from '../../../schemas/subscription'
import * as quotaLedger from '../../../schemas/subscription-quota-ledger'

export const SUBSCRIPTION_STATUSES = ['active', 'ended', 'canceled'] as const

export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number]

export interface SubscriptionSnapshot {
  id: string
  planKey: string
  status: SubscriptionStatus
  provider: string
  periodQuotaAmount: number
  periodQuotaUsed: number
  periodQuotaRemaining: number
  resetAt: string
  useBalance: boolean
}

export interface SubscriptionServiceDeps {
  db: Database
  clock?: Clock
}

type SubscriptionRow = typeof schema.subscription.$inferSelect

type DbHandle = Pick<Database, 'insert' | 'update' | 'select' | 'query'>

// Throw rolls back the ledger insert; returning null would commit an orphan row.
class QuotaConsumeRejected extends Error {
  constructor() {
    super('quota consume rejected')
    this.name = 'QuotaConsumeRejected'
  }
}

/**
 * Subscription + period-quota module.
 *
 * Owns the `subscription` row, lazy monthly windows, grant/reset, consume, and
 * end/reclaim. BillingService calls consume; Payment CORE calls grant/end.
 *
 * Call stack (consume):
 *
 * authorizeChat / consumeFluxForLLM
 * -> {@link createSubscriptionService} `getEntitlement` / `tryConsumeQuota`
 */
export function createSubscriptionService(deps: SubscriptionServiceDeps) {
  const clock = deps.clock ?? systemClock

  function effectiveUsed(row: SubscriptionRow, now: Date): number {
    const { start } = getMonthlyBounds(now, row.createdAt)
    if (row.periodQuotaUpdatedAt < start)
      return 0
    return row.periodQuotaUsed
  }

  function toSnapshot(row: SubscriptionRow, now: Date): SubscriptionSnapshot {
    const used = effectiveUsed(row, now)
    const { end } = getMonthlyBounds(now, row.createdAt)
    return {
      id: row.id,
      planKey: row.planKey,
      status: row.status as SubscriptionStatus,
      provider: row.provider,
      periodQuotaAmount: row.periodQuotaAmount,
      periodQuotaUsed: used,
      periodQuotaRemaining: Math.max(0, row.periodQuotaAmount - used),
      resetAt: end.toISOString(),
      useBalance: row.useBalance,
    }
  }

  async function findActiveForUser(db: DbHandle, userId: string): Promise<SubscriptionRow | null> {
    const row = await db.query.subscription.findFirst({
      where: and(
        eq(schema.subscription.userId, userId),
        eq(schema.subscription.status, 'active'),
        isNull(schema.subscription.deletedAt),
      ),
    })
    return row ?? null
  }

  async function findByProviderSubscription(
    db: DbHandle,
    input: { provider: string, providerSubscriptionId: string },
  ): Promise<SubscriptionRow | null> {
    const row = await db.query.subscription.findFirst({
      where: and(
        eq(schema.subscription.provider, input.provider),
        eq(schema.subscription.providerSubscriptionId, input.providerSubscriptionId),
        isNull(schema.subscription.deletedAt),
      ),
    })
    return row ?? null
  }

  return {
    async getEntitlement(userId: string): Promise<SubscriptionSnapshot | null> {
      const row = await findActiveForUser(deps.db, userId)
      if (!row)
        return null
      return toSnapshot(row, clock())
    },

    async getActiveRow(userId: string): Promise<SubscriptionRow | null> {
      return findActiveForUser(deps.db, userId)
    },

    /**
     * Creates or renews an active subscription and resets period quota.
     * Called from Payment when a plan invoice is paid.
     *
     * Same `providerSubscriptionId` renews the existing row.
     * A second active subscription for the user is rejected by
     * `subscription_user_active_uidx` (`ON CONFLICT DO NOTHING`).
     */
    async grantPeriod(input: {
      userId: string
      provider: string
      providerSubscriptionId: string
      planKey: string
      periodQuotaAmount: number
      providerData?: Record<string, unknown>
      tx?: DbHandle
    }): Promise<{ granted: true, subscriptionId: string } | { granted: false }> {
      const db = input.tx ?? deps.db
      const now = clock()

      const existing = await findByProviderSubscription(db, {
        provider: input.provider,
        providerSubscriptionId: input.providerSubscriptionId,
      })

      if (existing) {
        await db.update(schema.subscription)
          .set({
            userId: input.userId,
            planKey: input.planKey,
            status: 'active',
            periodQuotaAmount: input.periodQuotaAmount,
            periodQuotaUsed: 0,
            periodQuotaUpdatedAt: now,
            providerData: input.providerData ?? existing.providerData,
            updatedAt: now,
            deletedAt: null,
          })
          .where(eq(schema.subscription.id, existing.id))
        return { granted: true, subscriptionId: existing.id }
      }

      const [inserted] = await db.insert(schema.subscription).values({
        userId: input.userId,
        provider: input.provider,
        providerSubscriptionId: input.providerSubscriptionId,
        planKey: input.planKey,
        status: 'active',
        periodQuotaAmount: input.periodQuotaAmount,
        periodQuotaUsed: 0,
        periodQuotaUpdatedAt: now,
        useBalance: false,
        providerData: input.providerData,
      }).onConflictDoNothing({
        target: schema.subscription.userId,
        where: sql`${schema.subscription.status} = 'active' AND ${schema.subscription.deletedAt} IS NULL`,
      }).returning({ id: schema.subscription.id })

      if (!inserted)
        return { granted: false }

      return { granted: true, subscriptionId: inserted.id }
    },

    /**
     * Ends a subscription and reclaims remaining period quota.
     * `past_due` must not call this.
     */
    async endAndReclaim(input: {
      provider: string
      providerSubscriptionId: string
      status?: 'ended' | 'canceled'
      tx?: DbHandle
    }): Promise<{ ended: boolean }> {
      const db = input.tx ?? deps.db
      const row = await findByProviderSubscription(db, {
        provider: input.provider,
        providerSubscriptionId: input.providerSubscriptionId,
      })
      if (!row || row.status !== 'active')
        return { ended: false }

      const now = clock()
      await db.update(schema.subscription)
        .set({
          status: input.status ?? 'ended',
          periodQuotaUsed: row.periodQuotaAmount,
          periodQuotaUpdatedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.subscription.id, row.id))

      return { ended: true }
    },

    async setUseBalance(input: { userId: string, enabled: boolean }): Promise<SubscriptionSnapshot> {
      const row = await findActiveForUser(deps.db, input.userId)
      if (!row)
        throw createNotFoundError('No active subscription', { code: 'NO_SUBSCRIPTION' })

      const now = clock()
      const [updated] = await deps.db.update(schema.subscription)
        .set({ useBalance: input.enabled, updatedAt: now })
        .where(and(
          eq(schema.subscription.id, row.id),
          eq(schema.subscription.status, 'active'),
          isNull(schema.subscription.deletedAt),
        ))
        .returning()

      if (!updated)
        throw createForbiddenError('Subscription is not active')

      return toSnapshot(updated, now)
    },

    /**
     * Tries to charge `amount` against period quota.
     *
     * Opens a short transaction, inserts a ledger row first, then runs one
     * atomic CASE UPDATE. Callers do not pass a transaction.
     *
     * Returns null when there is no active subscription or quota cannot cover
     * the whole request. A matching `requestId` replays the first charge and
     * does not bump the counter again.
     */
    async tryConsumeQuota(input: {
      userId: string
      amount: number
      requestId?: string
    }): Promise<{ charged: number, remaining: number, subscriptionId: string } | null> {
      const now = clock()

      try {
        return await deps.db.transaction(async (tx) => {
          const row = await findActiveForUser(tx, input.userId)
          if (!row)
            return null

          const [inserted] = await tx
            .insert(quotaLedger.subscriptionQuotaLedger)
            .values({
              userId: input.userId,
              subscriptionId: row.id,
              requestId: input.requestId,
              amount: input.amount,
            })
            .onConflictDoNothing()
            .returning({
              amount: quotaLedger.subscriptionQuotaLedger.amount,
            })

          if (!inserted) {
            // Replay the first charge; ignore a different retry amount.
            if (input.requestId == null)
              throw createInternalError('Quota ledger insert conflicted without requestId')

            const [existing] = await tx
              .select({
                amount: quotaLedger.subscriptionQuotaLedger.amount,
                subscriptionId: quotaLedger.subscriptionQuotaLedger.subscriptionId,
              })
              .from(quotaLedger.subscriptionQuotaLedger)
              .where(and(
                eq(quotaLedger.subscriptionQuotaLedger.userId, input.userId),
                eq(quotaLedger.subscriptionQuotaLedger.requestId, input.requestId),
              ))
              .limit(1)

            if (!existing)
              throw createInternalError('Quota ledger conflicted but the original row is missing')

            const current = await findActiveForUser(tx, input.userId)
            const remaining = current
              ? Math.max(0, current.periodQuotaAmount - effectiveUsed(current, now))
              : 0

            return {
              charged: existing.amount,
              remaining,
              subscriptionId: existing.subscriptionId,
            }
          }

          const { start: windowStart } = getMonthlyBounds(now, row.createdAt)
          // SET and WHERE must share this CASE: an OR on "window expired" alone
          // would let amount > periodQuotaAmount through after reset.
          const [updated] = await tx
            .update(schema.subscription)
            .set({
              periodQuotaUsed: sql`(CASE WHEN ${schema.subscription.periodQuotaUpdatedAt} < ${windowStart} THEN 0 ELSE ${schema.subscription.periodQuotaUsed} END) + ${input.amount}`,
              periodQuotaUpdatedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(schema.subscription.userId, input.userId),
              eq(schema.subscription.status, 'active'),
              isNull(schema.subscription.deletedAt),
              sql`(CASE WHEN ${schema.subscription.periodQuotaUpdatedAt} < ${windowStart} THEN 0 ELSE ${schema.subscription.periodQuotaUsed} END) + ${input.amount} <= ${schema.subscription.periodQuotaAmount}`,
            ))
            .returning({
              id: schema.subscription.id,
              periodQuotaUsed: schema.subscription.periodQuotaUsed,
              periodQuotaAmount: schema.subscription.periodQuotaAmount,
            })

          if (!updated)
            throw new QuotaConsumeRejected()

          return {
            charged: input.amount,
            remaining: Math.max(0, updated.periodQuotaAmount - updated.periodQuotaUsed),
            subscriptionId: updated.id,
          }
        })
      }
      catch (error) {
        if (error instanceof QuotaConsumeRejected)
          return null
        throw error
      }
    },

    async deleteAllForUser(userId: string) {
      const now = clock()
      await deps.db.update(schema.subscription)
        .set({ deletedAt: now, updatedAt: now, status: 'ended' })
        .where(and(
          eq(schema.subscription.userId, userId),
          isNull(schema.subscription.deletedAt),
        ))
    },
  }
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>
