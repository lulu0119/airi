import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

import { sql } from 'drizzle-orm'
import { bigint, boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { nanoid } from '../utils/id'

// NOTICE: bare userId is intentional — no FK to user.id. better-auth hard-deletes
// the user row; a cascade would wipe soft-delete archive rows kept for billing.
// See `server/apps/api/docs/ai-context/account-deletion.md`.

/**
 * Product subscription and period-quota counters.
 *
 * Period windows are computed lazily from `created_at` (OpenCode-style).
 * There are no `current_period_start/end` columns.
 */
export const subscription = pgTable('subscription', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(),
  providerSubscriptionId: text('provider_subscription_id'),
  planKey: text('plan_key').notNull(),
  status: text('status').notNull(),
  /** Flux granted for the current period (snapshot from FLUX_PLANS). */
  periodQuotaAmount: bigint('period_quota_amount', { mode: 'number' }).notNull(),
  /** Flux consumed in the current period window. */
  periodQuotaUsed: bigint('period_quota_used', { mode: 'number' }).notNull().default(0),
  /** When period_quota_used was last written (lazy monthly reset compares against window start). */
  periodQuotaUpdatedAt: timestamp('period_quota_updated_at').defaultNow().notNull(),
  /** When true, consume falls through to Flux balance after quota is exhausted. */
  useBalance: boolean('use_balance').notNull().default(false),
  /**
   * Last consume requestId that charged quota. Immediate retries with the same
   * id skip a second counter bump.
   */
  lastConsumeRequestId: text('last_consume_request_id'),
  providerData: jsonb('provider_data').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  deletedAt: timestamp('deleted_at'),
}, table => [
  uniqueIndex('subscription_provider_sub_uidx')
    .on(table.provider, table.providerSubscriptionId)
    .where(sql`provider_subscription_id IS NOT NULL AND deleted_at IS NULL`),
  index('subscription_user_id_idx').on(table.userId),
  uniqueIndex('subscription_user_active_uidx')
    .on(table.userId)
    .where(sql`status = 'active' AND deleted_at IS NULL`),
])

export type Subscription = InferSelectModel<typeof subscription>
export type NewSubscription = InferInsertModel<typeof subscription>
