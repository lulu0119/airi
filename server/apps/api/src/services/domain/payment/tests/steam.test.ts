import type { SteamReportOrder } from '../adapters/steam-client'

import { describe, expect, it } from 'vitest'

import {
  evidenceReceiptFromSteamOrder,
  isSteamRefundShapedStatus,
  resolveSteamProviderOrderId,
} from '../adapters/steam'

describe('steam evidence mapper', () => {
  it('maps a GetReport order onto an evidence receipt without flux', () => {
    const order: SteamReportOrder = {
      orderid: '0',
      transid: '9876543210',
      steamid: '76561198000000000',
      status: 'Succeeded',
      currency: 'USD',
      time: '2026-08-16T12:00:00Z',
      items: [{ itemid: 1001, qty: 1, amount: 499, vat: 0, itemstatus: 'Succeeded' }],
    }

    expect(evidenceReceiptFromSteamOrder({ order, userId: 'user-1' })).toEqual({
      kind: 'evidence',
      provider: 'steam',
      providerOrderId: '9876543210',
      userId: 'user-1',
      productId: 1001,
      providerCustomerId: '76561198000000000',
      amount: 499,
      currency: 'usd',
      extras: {
        orderId: '0',
        transId: '9876543210',
        steamId: '76561198000000000',
        status: 'Succeeded',
        time: '2026-08-16T12:00:00Z',
        items: order.items,
      },
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
