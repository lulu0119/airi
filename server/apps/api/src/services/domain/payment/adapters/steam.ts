import type {
  ConfirmationFacts,
  PaymentProvider,
  ProviderCreateInput,
  ProviderCreateResult,
} from '../types'
import type { SteamReportOrder } from './steam-client'

import { createInternalError, createServiceUnavailableError } from '../../../../utils/error'

/**
 * Native payload for {@link createSteamPaymentProvider}.confirmed after the
 * channel resolves catalog snapshot and user binding from a GetReport order.
 */
export interface SteamConfirmedNative {
  order: SteamReportOrder
  userId: string
  packKey: string
  fluxAmount: number
  paymentOrderId?: string
}

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
 * Steam adapter for the Payment Provider port.
 *
 * Steam grant ingress is GetReport (worker/cron). `create` / `startPack` /
 * overlay checkout are not used here.
 */
export function createSteamPaymentProvider(): PaymentProvider {
  return {
    async listPackages() {
      return []
    },

    async create(_input: ProviderCreateInput): Promise<ProviderCreateResult> {
      throw createServiceUnavailableError(
        'Steam MicroTxn create is not used; grants come from GetReport',
        'STEAM_CREATE_UNSUPPORTED',
      )
    },

    confirmed(native: unknown): ConfirmationFacts {
      const value = native as SteamConfirmedNative
      const order = value.order
      const providerOrderId = resolveSteamProviderOrderId(order)
      if (!providerOrderId)
        throw createInternalError('Steam report order is missing transid/orderid')

      return {
        provider: 'steam',
        paymentOrderId: value.paymentOrderId,
        providerOrderId,
        status: 'paid',
        userId: value.userId,
        packKey: value.packKey,
        fluxAmount: value.fluxAmount,
        amount: sumSteamItemAmounts(order),
        currency: order.currency?.toLowerCase(),
        providerCustomerId: order.steamid,
        providerData: {
          orderId: order.orderid,
          transId: order.transid,
          steamId: order.steamid,
          status: order.status,
          time: order.time,
          items: order.items,
        },
      }
    },

    async cancel() {
      // One-time InitTxn carts are abandoned by Steam.
    },

    async getStatus() {
      return null
    },
  }
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

function sumSteamItemAmounts(order: SteamReportOrder): number | undefined {
  if (!order.items?.length)
    return undefined
  return order.items.reduce((sum, item) => sum + (item.amount ?? 0) + (item.vat ?? 0), 0)
}
