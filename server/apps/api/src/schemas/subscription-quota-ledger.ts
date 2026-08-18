import { sql } from 'drizzle-orm'
import { bigint, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'

import { nanoid } from '../utils/id'

// NOTICE: ledger is permanent — bare userId (no FK) and no `deletedAt` column,
// both intentional. Entries must outlive the user row, and better-auth's
// hard-delete of user.id must not cascade-wipe the ledger.
// See `server/apps/api/docs/ai-context/account-deletion.md`.

/**
 * Per-request period-quota charges.
 *
 * The unique `(user_id, request_id)` index makes retries idempotent.
 * `tryConsumeQuota` inserts here first, then updates the subscription counter
 * in the same transaction.
 */
export const subscriptionQuotaLedger = pgTable('subscription_quota_ledger', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull(),
  subscriptionId: text('subscription_id').notNull(),
  requestId: text('request_id'),
  amount: bigint('amount', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, table => [
  index('subscription_quota_ledger_user_id_idx').on(table.userId),
  uniqueIndex('subscription_quota_ledger_user_request_uniq')
    .on(table.userId, table.requestId)
    .where(sql`request_id IS NOT NULL`),
])
