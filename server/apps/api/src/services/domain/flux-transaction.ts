import type { Database } from '../../libs/db'
import type { SubscriptionService } from './subscription'

import { useLogger } from '@guiiai/logg'
import { and, desc, eq, inArray } from 'drizzle-orm'

import * as schema from '../../schemas/flux-transaction'
import * as llmSchema from '../../schemas/llm-request-log'

const logger = useLogger('flux-transaction')

export interface TransactionEntry {
  userId: string
  type: 'credit' | 'debit' | 'initial' | 'promo'
  amount: number
  balanceBefore: number
  balanceAfter: number
  requestId?: string
  description: string
  metadata?: Record<string, unknown>
}

export interface HistoryRecord {
  id: string
  type: string
  amount: number
  description: string
  metadata: Record<string, unknown> | null
  createdAt: Date
  /** `balance` for ledger rows; `quota` for period-quota llm_request_log rows. */
  billingSource: 'balance' | 'quota'
}

export function createFluxTransactionService(db: Database, subscription?: SubscriptionService) {
  return {
    async log(entry: TransactionEntry) {
      await db.insert(schema.fluxTransaction).values(entry)
      logger.withFields({ userId: entry.userId, type: entry.type, amount: entry.amount }).log('Transaction recorded')
    },

    async logBatch(entries: TransactionEntry[]) {
      if (entries.length === 0)
        return
      await db.insert(schema.fluxTransaction).values(entries)
      logger.withFields({ count: entries.length }).log('Transaction batch recorded')
    },

    /**
     * History = all flux_transaction rows plus llm_request_log rows with
     * source=quota. Balance-sourced log rows are omitted (they duplicate debits).
     *
     * Fetches a window from each source and merges in memory so mock DB and
     * Postgres share one code path.
     */
    async getHistory(userId: string, limit: number, offset: number) {
      const fetchLimit = offset + limit + 1

      const [ledgerRows, quotaRows] = await Promise.all([
        db.query.fluxTransaction.findMany({
          where: eq(schema.fluxTransaction.userId, userId),
          orderBy: [desc(schema.fluxTransaction.createdAt)],
          limit: fetchLimit,
        }),
        db.query.llmRequestLog.findMany({
          where: and(
            eq(llmSchema.llmRequestLog.userId, userId),
            eq(llmSchema.llmRequestLog.source, 'quota'),
          ),
          orderBy: [desc(llmSchema.llmRequestLog.createdAt)],
          limit: fetchLimit,
        }),
      ])

      const merged: HistoryRecord[] = [
        ...ledgerRows.map(row => ({
          id: row.id,
          type: row.type,
          amount: row.amount,
          description: row.description,
          metadata: (row.metadata as Record<string, unknown> | null) ?? null,
          createdAt: row.createdAt,
          billingSource: 'balance' as const,
        })),
        ...quotaRows.map(row => ({
          id: row.id,
          type: 'debit',
          amount: row.fluxConsumed,
          description: row.model,
          metadata: {
            model: row.model,
            ...(row.promptTokens != null && { promptTokens: row.promptTokens }),
            ...(row.completionTokens != null && { completionTokens: row.completionTokens }),
          },
          createdAt: row.createdAt,
          billingSource: 'quota' as const,
        })),
      ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())

      const page = merged.slice(offset, offset + limit + 1)
      const hasMore = page.length > limit
      if (hasMore)
        page.pop()

      return { records: page, hasMore }
    },

    async getStats(userId: string) {
      // Get the balance right after the most recent credit/initial/promo transaction
      // as the "capacity" for the progress bar. 'promo' (admin grant) bumps capacity
      // so the user's progress bar reflects the new total they have to spend.
      const [latestCredit] = await db.select({
        balanceAfter: schema.fluxTransaction.balanceAfter,
      })
        .from(schema.fluxTransaction)
        .where(
          and(
            eq(schema.fluxTransaction.userId, userId),
            inArray(schema.fluxTransaction.type, ['credit', 'initial', 'promo']),
          ),
        )
        .orderBy(desc(schema.fluxTransaction.createdAt))
        .limit(1)

      const entitlement = subscription
        ? await subscription.getEntitlement(userId)
        : null

      return {
        capacity: latestCredit?.balanceAfter ?? 0,
        subscription: entitlement
          ? {
              planKey: entitlement.planKey,
              provider: entitlement.provider,
              periodQuotaRemaining: entitlement.periodQuotaRemaining,
              periodQuotaTotal: entitlement.periodQuotaAmount,
              resetAt: entitlement.resetAt,
              useBalance: entitlement.useBalance,
            }
          : null,
      }
    },
  }
}

export type FluxTransactionService = ReturnType<typeof createFluxTransactionService>
