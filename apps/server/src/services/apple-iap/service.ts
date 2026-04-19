import type { Database } from '../../libs/db'
import type { AppleIapTransaction, NewAppleIapTransaction } from '../../schemas/apple-iap'

import { useLogger } from '@guiiai/logg'
import { eq } from 'drizzle-orm'

import * as schema from '../../schemas/apple-iap'

const logger = useLogger('apple-iap-service')

/**
 * CRUD service for the `apple_iap_transaction` table.
 *
 * Use when:
 * - The Apple IAP route needs to persist a verified StoreKit 2 transaction
 *   row before handing off to the billing service for idempotent credit.
 *
 * Expects:
 * - Rows are keyed by the StoreKit `transactionId`, which is unique per
 *   purchase (and different from `originalTransactionId` for consumables).
 * - `fluxCredited` is flipped inside `billing-service.creditFluxFromAppleIapPurchase`,
 *   not here.
 */
export function createAppleIapService(db: Database) {
  return {
    /**
     * Insert a new transaction row, or update the existing row if the same
     * `transactionId` has been observed before (e.g. client retry due to
     * a transient server error).
     *
     * Returns the persisted row.
     */
    async upsertTransaction(data: NewAppleIapTransaction): Promise<AppleIapTransaction> {
      const [row] = await db.insert(schema.appleIapTransaction)
        .values(data)
        .onConflictDoUpdate({
          target: schema.appleIapTransaction.transactionId,
          set: {
            ...data,
            updatedAt: new Date(),
          },
        })
        .returning()
      logger.withFields({
        userId: data.userId,
        transactionId: data.transactionId,
        productId: data.productId,
      }).log('Upserted Apple IAP transaction')
      return row
    },

    async getByTransactionId(transactionId: string): Promise<AppleIapTransaction | undefined> {
      return db.query.appleIapTransaction.findFirst({
        where: eq(schema.appleIapTransaction.transactionId, transactionId),
      })
    },
  }
}

export type AppleIapService = ReturnType<typeof createAppleIapService>
