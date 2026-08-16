import type Redis from 'ioredis'

import type { Database } from '../../../../libs/db'
import type { PaymentProvider, PaymentService } from '../../payment'
import type { SteamMicroTxnClient, SteamReportOrder } from '../adapters/steam-client'

import { useLogger } from '@guiiai/logg'
import { account } from '@proj-airi/auth-shared'
import { and, eq } from 'drizzle-orm'

import {
  isSteamRefundShapedStatus,
} from '../adapters/steam'

const logger = useLogger('payment.steam.report')

export const STEAM_REPORT_CURSOR_REDIS_KEY = 'steam:microtxn:report:cursor'

export interface SteamReportWorkerDeps {
  client: SteamMicroTxnClient
  payment: PaymentService
  steamAdapter: PaymentProvider
  db: Database
  redis: Redis
  /**
   * Report type passed to GetReport.
   * Pack-only phase uses settlement-shaped reports. Subscription reports wait
   * for the subscription PR.
   * @default 'SETTLEMENT'
   */
  reportType?: 'GAMESALES' | 'STEAMSTORESALES' | 'SETTLEMENT' | 'CHARGEBACK'
  /**
   * Fallback start time when Redis has no cursor (RFC 3339 UTC).
   * @default 7 days ago
   */
  initialTime?: string
  now?: () => Date
}

export interface SteamReportSyncResult {
  processed: number
  appliedPacks: number
  ignoredRefunds: number
  skipped: number
  cursor: string
}

/**
 * Pulls Steam GetReport pages and applies Payment CORE pack confirmations.
 *
 * This is the Steam channel ingress. It must run in a separate worker/cron
 * (HTTP sync route or CLI), never as an in-API poll loop.
 *
 * Refunded / Chargedback / PartialRefund (and fraud refund shapes): log and
 * ignore. Do not reverse Flux.
 *
 * Rows with `agreementid` are skipped until subscription support lands.
 */
export function createSteamReportWorker(deps: SteamReportWorkerDeps) {
  return {
    async syncOnce(): Promise<SteamReportSyncResult> {
      const now = deps.now?.() ?? new Date()
      const storedCursor = await deps.redis.get(STEAM_REPORT_CURSOR_REDIS_KEY)
      let cursor: string = storedCursor
        ?? deps.initialTime
        ?? new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')

      const result: SteamReportSyncResult = {
        processed: 0,
        appliedPacks: 0,
        ignoredRefunds: 0,
        skipped: 0,
        cursor,
      }

      // Steam docs: advance time from the last batch; keep the same time when empty.
      let guard = 0
      while (guard < 50) {
        guard += 1
        const page = await deps.client.getReport({
          time: cursor,
          type: deps.reportType ?? 'SETTLEMENT',
          maxResults: 1000,
        })

        if (page.orders.length === 0)
          break

        for (const order of page.orders) {
          result.processed += 1
          const outcome = await processReportOrder(deps, order)
          switch (outcome) {
            case 'pack':
              result.appliedPacks += 1
              break
            case 'refund':
              result.ignoredRefunds += 1
              break
            case 'skipped':
              result.skipped += 1
              break
            default: {
              const exhaustive: never = outcome
              throw new Error(`Unhandled steam report outcome: ${String(exhaustive)}`)
            }
          }
        }

        const latestTime: string = page.orders.reduce((latest: string, order) => {
          const candidate = order.time || order.timecreated || ''
          return candidate > latest ? candidate : latest
        }, cursor)

        if (latestTime === cursor)
          break
        cursor = latestTime
        await deps.redis.set(STEAM_REPORT_CURSOR_REDIS_KEY, cursor)
      }

      result.cursor = cursor
      await deps.redis.set(STEAM_REPORT_CURSOR_REDIS_KEY, cursor)
      return result
    },
  }
}

type ProcessOutcome = 'pack' | 'refund' | 'skipped'

async function processReportOrder(
  deps: SteamReportWorkerDeps,
  order: SteamReportOrder,
): Promise<ProcessOutcome> {
  if (isSteamRefundShapedStatus(order.status)) {
    logger.withFields({
      status: order.status,
      transId: order.transid,
      orderId: order.orderid,
      steamId: order.steamid,
    }).log('Ignoring Steam refund-shaped GetReport row')
    return 'refund'
  }

  if (order.status !== 'Succeeded') {
    logger.withFields({
      status: order.status,
      transId: order.transid,
      orderId: order.orderid,
    }).log('Skipping non-Succeeded Steam GetReport row')
    return 'skipped'
  }

  if (order.agreementid) {
    logger.withFields({
      agreementId: order.agreementid,
      transId: order.transid,
    }).log('Skipping Steam agreement row until subscription support lands')
    return 'skipped'
  }

  const userId = await resolveUserIdBySteamId(deps.db, order.steamid)
  if (!userId) {
    logger.withFields({ steamId: order.steamid, transId: order.transid }).warn('Steam GetReport user not linked')
    return 'skipped'
  }

  const primaryItem = order.items?.[0]
  if (!primaryItem) {
    logger.withFields({ transId: order.transid }).warn('Steam GetReport order has no items')
    return 'skipped'
  }

  const pack = await deps.payment.resolvePack({ provider: 'steam', providerProductId: primaryItem.itemid })
  if (!pack) {
    logger.withFields({ itemId: primaryItem.itemid, transId: order.transid }).warn('Unknown Steam pack item')
    return 'skipped'
  }

  const facts = deps.steamAdapter.confirmed({
    order,
    userId,
    packKey: pack.key,
    fluxAmount: pack.fluxAmount,
  })
  const confirmation = await deps.payment.applyConfirmation(facts)
  return confirmation.applied ? 'pack' : 'skipped'
}

async function resolveUserIdBySteamId(db: Database, steamId: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: account.userId })
    .from(account)
    .where(and(
      eq(account.providerId, 'steam'),
      eq(account.accountId, steamId),
    ))
    .limit(1)

  return row?.userId ?? null
}
