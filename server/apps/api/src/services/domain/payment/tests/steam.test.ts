import { describe, expect, it } from 'vitest'

import {
  createSteamPaymentProvider,
  isSteamRefundShapedStatus,
  resolveSteamProviderOrderId,
} from '../adapters/steam'

describe('steam payment adapter', () => {
  it('confirmed maps GetReport order into evidence-first ConfirmationFacts', () => {
    const steam = createSteamPaymentProvider()
    const facts = steam.confirmed({
      order: {
        orderid: '0',
        transid: '9876543210',
        steamid: '76561198000000000',
        status: 'Succeeded',
        currency: 'USD',
        time: '2026-08-16T12:00:00Z',
        items: [{ itemid: 1001, qty: 1, amount: 499, vat: 0, itemstatus: 'Succeeded' }],
      },
      userId: 'user-1',
      packKey: 'starter',
      fluxAmount: 500,
    })

    expect(facts).toMatchObject({
      provider: 'steam',
      providerOrderId: '9876543210',
      status: 'paid',
      userId: 'user-1',
      packKey: 'starter',
      fluxAmount: 500,
      providerCustomerId: '76561198000000000',
      amount: 499,
      currency: 'usd',
    })
    expect(facts.paymentOrderId).toBeUndefined()
  })

  it('create is unsupported for GetReport-first grants', async () => {
    const steam = createSteamPaymentProvider()
    await expect(steam.create({
      paymentOrderId: 'po_1',
      userId: 'user-1',
      pack: {
        key: 'starter',
        name: '500 Flux',
        fluxAmount: 500,
        recommended: false,
        providers: {},
      },
      successUrl: 'https://example.test/ok',
      cancelUrl: 'https://example.test/cancel',
    })).rejects.toMatchObject({
      statusCode: 503,
      errorCode: 'STEAM_CREATE_UNSUPPORTED',
    })
  })

  it('resolveSteamProviderOrderId prefers transid over zero orderid', () => {
    expect(resolveSteamProviderOrderId({ orderid: '0', transid: '42' })).toBe('42')
    expect(resolveSteamProviderOrderId({ orderid: '99', transid: '0' })).toBe('99')
  })
})

describe('isSteamRefundShapedStatus', () => {
  it('flags refund and chargeback shapes for log-and-ignore', () => {
    expect(isSteamRefundShapedStatus('Refunded')).toBe(true)
    expect(isSteamRefundShapedStatus('PartialRefund')).toBe(true)
    expect(isSteamRefundShapedStatus('Chargedback')).toBe(true)
    expect(isSteamRefundShapedStatus('Succeeded')).toBe(false)
  })
})
