import type { FluxService } from '../../services/domain/flux'
import type { FluxTransactionService } from '../../services/domain/flux-transaction'
import type { SubscriptionService } from '../../services/domain/subscription'
import type { HonoEnv } from '../../types/hono'

import { Hono } from 'hono'
import { boolean, object, parse, safeParse } from 'valibot'

import { authGuard } from '../../middlewares/auth'
import { createBadRequestError } from '../../utils/error'
import { LimitOffsetPaginationQuerySchema } from '../../utils/http-query'

const UseBalanceBodySchema = object({
  enabled: boolean(),
})

export function createFluxRoutes(
  fluxService: FluxService,
  fluxTransactionService: FluxTransactionService,
  subscriptionService?: SubscriptionService,
) {
  return new Hono<HonoEnv>()
    .use('*', authGuard)
    .get('/', async (c) => {
      const user = c.get('user')!
      const flux = await fluxService.getFlux(user.id)
      return c.json(flux)
    })
    .get('/stats', async (c) => {
      const user = c.get('user')!
      const stats = await fluxTransactionService.getStats(user.id)
      return c.json(stats)
    })
    .put('/use-balance', async (c) => {
      if (!subscriptionService)
        throw createBadRequestError('Subscriptions are not available', 'SUBSCRIPTION_UNAVAILABLE')

      const user = c.get('user')!
      const parsed = safeParse(UseBalanceBodySchema, await c.req.json())
      if (!parsed.success)
        throw createBadRequestError('Invalid request', 'INVALID_REQUEST', parsed.issues)

      const snapshot = await subscriptionService.setUseBalance({
        userId: user.id,
        enabled: parsed.output.enabled,
      })

      return c.json({
        useBalance: snapshot.useBalance,
        planKey: snapshot.planKey,
      })
    })
    .get('/history', async (c) => {
      const user = c.get('user')!
      const { limit, offset } = parse(LimitOffsetPaginationQuerySchema, {
        limit: c.req.query('limit'),
        offset: c.req.query('offset'),
      })

      const { records, hasMore } = await fluxTransactionService.getHistory(user.id, limit, offset)

      return c.json({
        records: records.map(r => ({
          id: r.id,
          type: r.type,
          amount: r.amount,
          description: r.description,
          metadata: r.metadata,
          createdAt: r.createdAt.toISOString(),
          billingSource: r.billingSource,
        })),
        hasMore,
      })
    })
}
