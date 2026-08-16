import type { EvidenceReceipt } from '../types'
import type { SteamReportOrder } from './steam-client'

import { createInternalError } from '../../../../utils/error'

/**
 * Steam GetReport statuses that must not reverse Flux (log and ignore).
 */
export const STEAM_REFUND_SHAPED_STATUSES = new Set([
  'Refunded',
  'PartialRefund',
  'Chargedback',
  'RefundedSuspectedFraud',
  'RefundedFriendlyFraud',
])

export function isSteamRefundShapedStatus(status: string): boolean {
  return STEAM_REFUND_SHAPED_STATUSES.has(status)
}

/**
 * Prefer `transid` as the durable provider order id. Steam store renewals may
 * report `orderid` as `0`.
 */
export function resolveSteamProviderOrderId(order: Pick<SteamReportOrder, 'orderid' | 'transid'>): string {
  if (order.transid && order.transid !== '0')
    return String(order.transid)
  if (order.orderid && order.orderid !== '0')
    return String(order.orderid)
  return ''
}

/**
 * Maps a Steam GetReport order onto a CORE evidence receipt.
 *
 * CORE resolves the pack from `productId`. This mapper does not pass flux.
 */
export function evidenceReceiptFromSteamOrder(input: {
  order: SteamReportOrder
  userId: string
}): EvidenceReceipt {
  const providerOrderId = resolveSteamProviderOrderId(input.order)
  if (!providerOrderId)
    throw createInternalError('Steam report order is missing transid/orderid')

  const productId = input.order.items?.[0]?.itemid
  if (productId == null)
    throw createInternalError('Steam report order is missing itemid')

  return {
    kind: 'evidence',
    provider: 'steam',
    providerOrderId,
    userId: input.userId,
    productId,
    amount: sumSteamItemAmounts(input.order),
    currency: input.order.currency?.toLowerCase(),
    providerCustomerId: input.order.steamid,
    extras: {
      orderId: input.order.orderid,
      transId: input.order.transid,
      steamId: input.order.steamid,
      status: input.order.status,
      time: input.order.time,
      items: input.order.items,
    },
  }
}

function sumSteamItemAmounts(order: SteamReportOrder): number | undefined {
  if (!order.items?.length)
    return undefined
  return order.items.reduce((sum, item) => sum + (item.amount ?? 0) + (item.vat ?? 0), 0)
}
