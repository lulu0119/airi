import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library'

import type { ConfirmationFacts, PaymentProvider, ProviderCreateInput, ProviderCreateResult } from '../types'

import { createInternalError, createServiceUnavailableError } from '../../../../utils/error'

/**
 * Native payload for {@link createApplePaymentProvider}.confirmed after the
 * channel verifies the JWS and resolves the catalog snapshot.
 */
export interface AppleConfirmedNative {
  transaction: JWSTransactionDecodedPayload
  userId: string
  packKey: string
  fluxAmount: number
}

/**
 * Apple adapter for the Payment Provider port.
 *
 * Apple is evidence-first: the channel verifies JWS, then calls `confirmed`.
 * `create` / `startPack` are not used for Apple.
 */
export function createApplePaymentProvider(): PaymentProvider {
  return {
    async create(_input: ProviderCreateInput): Promise<ProviderCreateResult> {
      throw createServiceUnavailableError(
        'Apple IAP does not create checkout sessions',
        'APPLE_IAP_CREATE_UNSUPPORTED',
      )
    },

    confirmed(native: unknown): ConfirmationFacts {
      const value = native as AppleConfirmedNative
      const transaction = value.transaction
      const transactionId = transaction.transactionId
      if (!transactionId)
        throw createInternalError('Apple transaction is missing transactionId')

      return {
        provider: 'apple_iap',
        providerOrderId: transactionId,
        status: 'paid',
        userId: value.userId,
        packKey: value.packKey,
        fluxAmount: value.fluxAmount,
        amount: transaction.price ?? undefined,
        currency: transaction.currency ?? undefined,
        providerCustomerId: transaction.appAccountToken,
        providerData: {
          transactionId,
          originalTransactionId: transaction.originalTransactionId,
          productId: transaction.productId,
          bundleId: transaction.bundleId,
          environment: transaction.environment,
          appAccountToken: transaction.appAccountToken,
          purchaseDate: transaction.purchaseDate,
          type: transaction.type,
          webOrderLineItemId: transaction.webOrderLineItemId,
        },
      }
    },

    async cancel() {
      // StoreKit purchases are not expired from our server.
    },

    async getStatus() {
      return null
    },
  }
}
