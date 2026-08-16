import { bigint, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { nanoid } from '../utils/id'

export const llmRequestLog = pgTable('llm_request_log', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull(), // NOTICE: do NOT use foreign key constraint here to avoid potential performance issues on high-concurrency writes
  model: text('model').notNull(),
  status: integer('status').notNull(),
  durationMs: integer('duration_ms').notNull(),
  fluxConsumed: bigint('flux_consumed', { mode: 'number' }).notNull(),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  /**
   * Billing source for this request.
   * - `quota`: charged against subscription period quota (no flux_transaction)
   * - `balance`: charged against user_flux (ledger also written)
   * Null for non-billable / failed pre-settle logs.
   */
  source: text('source'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
