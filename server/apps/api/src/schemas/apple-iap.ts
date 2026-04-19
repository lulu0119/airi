import type { InferInsertModel, InferSelectModel } from 'drizzle-orm'

import { relations } from 'drizzle-orm'
import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

import { nanoid } from '../utils/id'
import { user } from './accounts'

/**
 * One row per verified StoreKit 2 transaction submitted by the iOS client.
 *
 * Only stores the decoded JWS payload fields we actually need, not the raw
 * JWS string itself — verification has already happened before insert, and
 * storing the signed blob adds no information value while bloating the row.
 *
 * Mirrors the role of `stripe_checkout_session`: a single business object
 * that participates in the idempotent Flux credit claim via the
 * `fluxCredited` flag.
 */
export const appleIapTransaction = pgTable('apple_iap_transaction', {
  id: text('id').primaryKey().$defaultFn(() => nanoid()),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  transactionId: text('transaction_id').notNull().unique(),
  originalTransactionId: text('original_transaction_id').notNull(),
  productId: text('product_id').notNull(),
  bundleId: text('bundle_id').notNull(),
  // 'Sandbox' | 'Production' (StoreKit 2 `environment` field)
  environment: text('environment').notNull(),
  appAccountToken: text('app_account_token'),
  purchaseDate: timestamp('purchase_date').notNull(),
  quantity: integer('quantity').notNull().default(1),
  // StoreKit 2 `price` field is a micro-units integer (e.g. $0.99 -> 990000).
  priceMicros: integer('price_micros'),
  currency: text('currency'),
  fluxAmount: integer('flux_amount').notNull(),
  fluxCredited: boolean('flux_credited').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
})

export const appleIapTransactionRelations = relations(appleIapTransaction, ({ one }) => ({
  user: one(user, { fields: [appleIapTransaction.userId], references: [user.id] }),
}))

export type AppleIapTransaction = InferSelectModel<typeof appleIapTransaction>
export type NewAppleIapTransaction = InferInsertModel<typeof appleIapTransaction>
