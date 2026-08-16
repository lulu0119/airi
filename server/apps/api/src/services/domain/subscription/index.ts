import type { Database } from '../../../libs/db'
import type { Clock } from './monthly-bounds'

import { and, eq, isNull } from 'drizzle-orm'

import { createForbiddenError, createInternalError, createNotFoundError } from '../../../utils/error'
import { getMonthlyBounds, systemClock } from './monthly-bounds'

import * as schema from '../../../schemas/subscription'

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
     */
    async grantPeriod(input: {
      userId: string
      provider: string
      providerSubscriptionId: string
      planKey: string
      periodQuotaAmount: number
      providerData?: Record<string, unknown>
      tx?: DbHandle
    }): Promise<{ subscriptionId: string }> {
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
        return { subscriptionId: existing.id }
      }

      // End any other active subscription for this user before inserting.
      const prior = await findActiveForUser(db, input.userId)
      if (prior) {
        await db.update(schema.subscription)
          .set({
            status: 'ended',
            periodQuotaUsed: prior.periodQuotaAmount,
            periodQuotaUpdatedAt: now,
            updatedAt: now,
          })
          .where(eq(schema.subscription.id, prior.id))
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
      }).returning({ id: schema.subscription.id })

      if (!inserted)
        throw createInternalError('Failed to create subscription')

      return { subscriptionId: inserted.id }
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
     * Returns null when quota cannot cover the whole request.
     */
    async tryConsumeQuota(input: {
      userId: string
      amount: number
      requestId?: string
      tx?: Pick<Database, 'update' | 'select' | 'query'>
    }): Promise<{ charged: number, remaining: number, subscriptionId: string } | null> {
      const db = input.tx ?? deps.db
      const now = clock()

      const [row] = await db
        .select()
        .from(schema.subscription)
        .where(and(
          eq(schema.subscription.userId, input.userId),
          eq(schema.subscription.status, 'active'),
          isNull(schema.subscription.deletedAt),
        ))
        .for('update')
        .limit(1)

      if (!row)
        return null

      if (input.requestId && row.lastConsumeRequestId === input.requestId) {
        const used = effectiveUsed(row, now)
        return {
          charged: input.amount,
          remaining: Math.max(0, row.periodQuotaAmount - used),
          subscriptionId: row.id,
        }
      }

      const used = effectiveUsed(row, now)
      const remaining = row.periodQuotaAmount - used
      if (remaining < input.amount)
        return null

      const nextUsed = used + input.amount
      await db.update(schema.subscription)
        .set({
          periodQuotaUsed: nextUsed,
          periodQuotaUpdatedAt: now,
          lastConsumeRequestId: input.requestId ?? row.lastConsumeRequestId,
          updatedAt: now,
        })
        .where(eq(schema.subscription.id, row.id))

      return {
        charged: input.amount,
        remaining: row.periodQuotaAmount - nextUsed,
        subscriptionId: row.id,
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
