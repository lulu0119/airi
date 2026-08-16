import type Redis from 'ioredis'

import type { Database } from '../../libs/db'
import type { RateLimitMetrics } from '../../otel'
import type { PaymentProvider, PaymentService } from '../../services/domain/payment'
import type { SteamMicroTxnClient } from '../../services/domain/payment/adapters/steam-client'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { safeParse } from 'valibot'

import { createSteamReportWorker } from '../../services/domain/payment/workers/steam-report'
import { createServiceUnavailableError, createUnauthorizedError } from '../../utils/error'
import { SyncReportBodySchema } from './schema'

export interface SteamRouteDeps {
  payment: PaymentService
  steamAdapter: PaymentProvider
  steamClient: SteamMicroTxnClient | null
  db: Database
  redis: Redis
  /**
   * Shared secret for cron/worker HTTP sync. When unset, sync returns 503.
   */
  reportCronSecret: string | null
  rateLimitMetrics?: RateLimitMetrics | null
}

/**
 * Steam MicroTxn channel routes at `/api/v1/steam`.
 *
 * - `POST /reports/sync` — cron/worker trigger for GetReport (not an in-API poll).
 *
 * Overlay checkout and Flux UI are out of Phase 4.
 */
export function createSteamRoutes(deps: SteamRouteDeps) {
  return new Hono<HonoEnv>()
    .post('/reports/sync', async (c) => {
      if (!deps.steamClient)
        throw createServiceUnavailableError('Steam MicroTxn is not configured', 'STEAM_MICROTXN_DISABLED')
      if (!deps.reportCronSecret)
        throw createServiceUnavailableError('Steam report cron secret is not configured', 'STEAM_REPORT_CRON_DISABLED')

      const auth = c.req.header('authorization')
      const token = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : null
      if (!token || token !== deps.reportCronSecret)
        throw createUnauthorizedError('Invalid Steam report cron secret')

      const body = await c.req.json().catch(() => ({}))
      const parsed = safeParse(SyncReportBodySchema, body)
      if (!parsed.success) {
        return c.json({ error: 'INVALID_REQUEST', message: 'Invalid sync body' }, 400)
      }

      const worker = createSteamReportWorker({
        client: deps.steamClient,
        payment: deps.payment,
        steamAdapter: deps.steamAdapter,
        db: deps.db,
        redis: deps.redis,
        reportType: parsed.output.type,
        initialTime: parsed.output.time,
      })

      const result = await worker.syncOnce()
      return c.json(result)
    })
}
