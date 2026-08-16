import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library'

import { describe, expect, it } from 'vitest'

import { createApplePaymentProvider } from '../adapters/apple'

describe('createApplePaymentProvider', () => {
  const provider = createApplePaymentProvider()

  it('maps a verified transaction into evidence-first confirmation facts', () => {
    const transaction = {
      transactionId: 'txn_1',
      originalTransactionId: 'orig_1',
      productId: 'flux.pack.500',
      appAccountToken: 'token-1',
      price: 4990000,
      currency: 'USD',
      bundleId: 'ai.moeru.airi',
      environment: 'Sandbox',
      purchaseDate: 1,
      type: 'Consumable',
      webOrderLineItemId: 'line-1',
    } as JWSTransactionDecodedPayload

    expect(provider.confirmed({
      transaction,
      userId: 'user-1',
      packKey: 'starter',
      fluxAmount: 500,
    })).toEqual({
      provider: 'apple_iap',
      providerOrderId: 'txn_1',
      status: 'paid',
      userId: 'user-1',
      packKey: 'starter',
      fluxAmount: 500,
      amount: 4990000,
      currency: 'USD',
      providerCustomerId: 'token-1',
      providerData: {
        transactionId: 'txn_1',
        originalTransactionId: 'orig_1',
        productId: 'flux.pack.500',
        bundleId: 'ai.moeru.airi',
        environment: 'Sandbox',
        appAccountToken: 'token-1',
        purchaseDate: 1,
        type: 'Consumable',
        webOrderLineItemId: 'line-1',
      },
    })
  })

  it('rejects create because Apple is evidence-first', async () => {
    await expect(provider.create({
      paymentOrderId: 'po_1',
      userId: 'user-1',
      pack: {
        key: 'starter',
        name: '500 Flux',
        fluxAmount: 500,
        recommended: false,
        providers: { appleIap: { productId: 'flux.pack.500' } },
      },
      successUrl: 'https://example.com/ok',
      cancelUrl: 'https://example.com/cancel',
    })).rejects.toMatchObject({ errorCode: 'APPLE_IAP_CREATE_UNSUPPORTED' })
  })
})
