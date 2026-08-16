import type { Database } from '../../../libs/db'
import type { ConfigKVService } from '../../adapters/config-kv'
import type { BillingService } from '../billing/billing-service'
import type { SubscriptionService } from '../subscription'
import type {
  ApplyConfirmationResult,
  ApplyPlanInvoiceResult,
  CatalogProviderIds,
  ConfirmationFacts,
  FluxPack,
  FluxPackListItem,
  FluxPlan,
  FluxPlanListItem,
  PaymentProvider,
  PaymentProviderName,
  PlanInvoiceFacts,
  ProviderProductRef,
  StartPackInput,
  StartPackResult,
  StartPlanInput,
  StartPlanResult,
} from './types'

import { useLogger } from '@guiiai/logg'
import { and, eq, inArray, isNull } from 'drizzle-orm'

import { createBadRequestError, createConflictError, createInternalError, createServiceUnavailableError } from '../../../utils/error'

import * as schema from '../../../schemas/payment'

export { createApplePaymentProvider } from './adapters/apple'
export { createAppleIapVerifier } from './adapters/apple-verifier'
export {
  createSteamPaymentProvider,
  isSteamRefundShapedStatus,
} from './adapters/steam'
export { createSteamMicroTxnClient } from './adapters/steam-client'
export { createStripePaymentProvider } from './adapters/stripe'
export type {
  ApplyConfirmationResult,
  ApplyPlanInvoiceResult,
  ConfirmationFacts,
  FluxPack,
  FluxPackListItem,
  FluxPlan,
  FluxPlanListItem,
  PackStartContext,
  PaymentProvider,
  PlanInvoiceFacts,
  StartPackInput,
  StartPackResult,
  StartPlanInput,
  StartPlanResult,
} from './types'
export { createSteamReportWorker } from './workers/steam-report'

const logger = useLogger('payment')

const OPEN_CHECKOUT_CANCEL_STATUSES = ['pending'] as const

function catalogProductId(providers: CatalogProviderIds, provider: PaymentProviderName): string | number | undefined {
  if (provider === 'stripe')
    return providers.stripe?.priceId
  if (provider === 'apple_iap')
    return providers.appleIap?.productId
  if (provider === 'steam')
    return providers.steam?.itemId

  const exhaustive: never = provider
  return exhaustive
}

export interface PaymentServiceDeps {
  db: Database
  billing: BillingService
  configKV: ConfigKVService
  subscription: SubscriptionService
  providers: Partial<Record<PaymentProviderName, PaymentProvider>>
}

/**
 * Payment CORE: pack/plan checkout, claim, plan invoice grant, and deletion.
 *
 * Call stack:
 *
 * Stripe `POST /checkout` pack
 * -> {@link createPaymentService} `startPack`
 * -> Provider `create` (kind pack)
 *
 * Stripe `POST /checkout` plan
 * -> {@link createPaymentService} `startPlan`
 * -> Provider `create` (kind plan)
 *
 * Stripe `POST /webhook` pack paid
 * -> Provider `confirmed`
 * -> {@link createPaymentService} `applyConfirmation`
 * -> {@link BillingService.creditFlux}
 *
 * Apple `POST /transactions` pack
 * -> verify JWS (channel)
 * -> Provider `confirmed`
 * -> {@link createPaymentService} `applyConfirmation` (evidence-first)
 * -> {@link BillingService.creditFlux}
 *
 * Stripe `invoice.paid`
 * -> {@link createPaymentService} `applyPlanInvoice`
 * -> {@link SubscriptionService.grantPeriod}
 */
export function createPaymentService(deps: PaymentServiceDeps) {
  function requireProvider(provider: PaymentProviderName): PaymentProvider {
    const adapter = deps.providers[provider]
    if (!adapter)
      throw createServiceUnavailableError('Payment provider is not configured', 'PAYMENT_PROVIDER_UNAVAILABLE', { provider })
    return adapter
  }

  async function loadFluxPacks(): Promise<FluxPack[]> {
    const packs = await deps.configKV.getOptional('FLUX_PACKS') ?? []
    return packs.map(pack => ({
      key: pack.key,
      name: pack.name,
      fluxAmount: pack.fluxAmount,
      recommended: pack.recommended ?? false,
      providers: pack.providers ?? {},
    }))
  }

  async function getFluxPackByKey(packKey: string): Promise<FluxPack> {
    const pack = (await loadFluxPacks()).find(item => item.key === packKey)
    if (!pack)
      throw createBadRequestError('Invalid pack', 'INVALID_PACKAGE', { packKey })
    return pack
  }

  async function resolvePack(ref: ProviderProductRef): Promise<FluxPack | null> {
    const packs = await loadFluxPacks()
    return packs.find(item => catalogProductId(item.providers, ref.provider) === ref.providerProductId) ?? null
  }

  async function loadFluxPlans(): Promise<FluxPlan[]> {
    const plans = await deps.configKV.getOptional('FLUX_PLANS') ?? []
    return plans.map(plan => ({
      key: plan.key,
      name: plan.name,
      periodQuota: plan.periodQuota,
      periodMonths: plan.periodMonths ?? 1,
      recommended: plan.recommended ?? false,
      defaultCurrency: plan.defaultCurrency,
      displayPrices: plan.displayPrices,
      providers: plan.providers ?? {},
    }))
  }

  async function listFluxPlans(): Promise<FluxPlanListItem[]> {
    return (await loadFluxPlans()).map(plan => ({
      planKey: plan.key,
      ...(plan.providers.stripe?.priceId ? { stripePriceId: plan.providers.stripe.priceId } : {}),
      label: plan.name,
      periodQuota: plan.periodQuota,
      periodMonths: plan.periodMonths,
      defaultCurrency: plan.defaultCurrency,
      currencies: plan.displayPrices,
      recommended: plan.recommended,
    }))
  }

  async function getFluxPlanByKey(planKey: string): Promise<FluxPlan> {
    const plan = (await loadFluxPlans()).find(item => item.key === planKey)
    if (!plan)
      throw createBadRequestError('Invalid plan', 'INVALID_PLAN', { planKey })
    return plan
  }

  async function resolvePlan(ref: ProviderProductRef): Promise<FluxPlan | null> {
    const plans = await loadFluxPlans()
    return plans.find(item => catalogProductId(item.providers, ref.provider) === ref.providerProductId) ?? null
  }

  async function upsertProviderAccount(
    tx: Pick<Database, 'insert' | 'update' | 'select'>,
    input: { userId: string, provider: string, providerCustomerId: string },
  ) {
    const [existing] = await tx
      .select({ id: schema.providerAccount.id })
      .from(schema.providerAccount)
      .where(and(
        eq(schema.providerAccount.provider, input.provider),
        eq(schema.providerAccount.providerCustomerId, input.providerCustomerId),
        isNull(schema.providerAccount.deletedAt),
      ))
      .limit(1)

    const now = new Date()
    if (existing) {
      await tx.update(schema.providerAccount)
        .set({ userId: input.userId, updatedAt: now })
        .where(eq(schema.providerAccount.id, existing.id))
      return
    }

    await tx.insert(schema.providerAccount).values({
      userId: input.userId,
      provider: input.provider,
      providerCustomerId: input.providerCustomerId,
    })
  }

  async function resolveUserIdFromCustomer(input: {
    provider: string
    providerCustomerId?: string
    userId?: string
  }): Promise<string | null> {
    if (input.userId)
      return input.userId
    if (!input.providerCustomerId)
      return null

    const [account] = await deps.db
      .select({ userId: schema.providerAccount.userId })
      .from(schema.providerAccount)
      .where(and(
        eq(schema.providerAccount.provider, input.provider),
        eq(schema.providerAccount.providerCustomerId, input.providerCustomerId),
        isNull(schema.providerAccount.deletedAt),
      ))
      .limit(1)

    return account?.userId ?? null
  }

  async function syncCreditCache(result: ApplyConfirmationResult) {
    if (result.applied) {
      await deps.billing.syncFluxCache(result.userId, result.balanceAfter, {
        amount: result.fluxAmount,
        source: 'payment.pack',
      })
    }
  }

  async function creditClaimedOrder(
    tx: Pick<Database, 'insert' | 'update' | 'select'>,
    input: {
      order: typeof schema.paymentOrder.$inferSelect
      facts: ConfirmationFacts
      fluxAmount: number
    },
  ): Promise<ApplyConfirmationResult> {
    const [claimed] = await tx.update(schema.paymentOrder)
      .set({
        status: 'paid',
        creditedAt: new Date(),
        providerOrderId: input.facts.providerOrderId,
        amount: input.facts.amount ?? input.order.amount,
        currency: input.facts.currency ?? input.order.currency,
        providerData: input.facts.providerData ?? input.order.providerData,
        packKey: input.facts.packKey ?? input.order.packKey,
        fluxAmount: input.fluxAmount,
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.paymentOrder.id, input.order.id),
        eq(schema.paymentOrder.status, 'pending'),
      ))
      .returning()

    if (!claimed)
      return { applied: false as const }

    const credit = await deps.billing.creditFlux({
      userId: input.order.userId,
      amount: input.fluxAmount,
      requestId: input.order.id,
      description: `Flux pack ${claimed.packKey ?? 'unknown'}`,
      source: 'payment.pack',
      tx,
    })

    if (input.facts.providerCustomerId) {
      await upsertProviderAccount(tx, {
        userId: input.order.userId,
        provider: input.order.provider,
        providerCustomerId: input.facts.providerCustomerId,
      })
    }

    return {
      applied: true as const,
      userId: input.order.userId,
      fluxAmount: input.fluxAmount,
      balanceAfter: credit.balanceAfter,
    }
  }

  /**
   * Stripe-style claim: pending order already exists from startPack.
   */
  async function claimExistingOrder(facts: ConfirmationFacts): Promise<ApplyConfirmationResult> {
    const paymentOrderId = facts.paymentOrderId
    if (!paymentOrderId)
      throw createInternalError('Payment confirmation is missing payment_order_id')

    const result = await deps.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(schema.paymentOrder)
        .where(eq(schema.paymentOrder.id, paymentOrderId))
        .for('update')

      if (!order)
        throw createInternalError('Payment order not found')

      // Plan checkout sessions expire/cancel through this path; paid plan
      // invoices use applyPlanInvoice and must not credit balance here.
      if (order.planKey && facts.status === 'paid')
        return { applied: false as const }

      switch (facts.status) {
        case 'paid': {
          if (order.status === 'paid')
            return { applied: false as const }

          if (order.status !== 'pending')
            return { applied: false as const }

          const fluxAmount = order.fluxAmount
          if (fluxAmount == null || fluxAmount <= 0)
            throw createInternalError('Payment order is missing flux_amount')

          return creditClaimedOrder(tx, { order, facts, fluxAmount })
        }
        case 'canceled':
        case 'expired': {
          if (order.status !== 'pending')
            return { applied: false as const }

          await tx.update(schema.paymentOrder)
            .set({
              status: facts.status,
              providerOrderId: facts.providerOrderId,
              providerData: facts.providerData ?? order.providerData,
              updatedAt: new Date(),
            })
            .where(and(
              eq(schema.paymentOrder.id, order.id),
              eq(schema.paymentOrder.status, 'pending'),
            ))

          return { applied: false as const }
        }
        default: {
          const exhaustive: never = facts.status
          throw createInternalError(`Unhandled payment confirmation status: ${String(exhaustive)}`)
        }
      }
    })

    await syncCreditCache(result)
    return result
  }

  /**
   * Evidence-first claim (Apple IAP): insert paid order by providerOrderId, or
   * replay when the row already exists.
   */
  async function claimEvidenceOrder(facts: ConfirmationFacts): Promise<ApplyConfirmationResult> {
    if (facts.status !== 'paid')
      throw createInternalError('Evidence confirmation only supports paid status')
    if (!facts.userId)
      throw createInternalError('Evidence confirmation is missing userId')
    if (!facts.packKey || facts.fluxAmount == null || facts.fluxAmount <= 0)
      throw createInternalError('Evidence confirmation is missing pack snapshot')

    const userId = facts.userId
    const packKey = facts.packKey
    const fluxAmount = facts.fluxAmount

    const result = await deps.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(schema.paymentOrder)
        .where(and(
          eq(schema.paymentOrder.provider, facts.provider),
          eq(schema.paymentOrder.providerOrderId, facts.providerOrderId),
        ))
        .for('update')
        .limit(1)

      if (existing) {
        if (existing.status === 'paid')
          return { applied: false as const }
        if (existing.status === 'pending')
          return creditClaimedOrder(tx, { order: existing, facts, fluxAmount })
        return { applied: false as const }
      }

      const [inserted] = await tx.insert(schema.paymentOrder).values({
        userId,
        provider: facts.provider,
        providerOrderId: facts.providerOrderId,
        status: 'paid',
        packKey,
        fluxAmount,
        amount: facts.amount,
        currency: facts.currency,
        creditedAt: new Date(),
        providerData: facts.providerData,
      }).onConflictDoNothing().returning()

      if (!inserted) {
        const [raced] = await tx
          .select({ status: schema.paymentOrder.status })
          .from(schema.paymentOrder)
          .where(and(
            eq(schema.paymentOrder.provider, facts.provider),
            eq(schema.paymentOrder.providerOrderId, facts.providerOrderId),
          ))
          .limit(1)
        if (raced?.status === 'paid')
          return { applied: false as const }
        throw createInternalError('Evidence confirmation lost the insert race')
      }

      const credit = await deps.billing.creditFlux({
        userId,
        amount: fluxAmount,
        requestId: inserted.id,
        description: `Flux pack ${packKey}`,
        source: 'payment.pack',
        tx,
      })

      if (facts.providerCustomerId) {
        await upsertProviderAccount(tx, {
          userId,
          provider: facts.provider,
          providerCustomerId: facts.providerCustomerId,
        })
      }

      return {
        applied: true as const,
        userId,
        fluxAmount,
        balanceAfter: credit.balanceAfter,
      }
    })

    await syncCreditCache(result)
    return result
  }

  return {
    async listPacks(provider: PaymentProviderName): Promise<FluxPackListItem[]> {
      const adapter = requireProvider(provider)
      return adapter.listPackages(await loadFluxPacks())
    },
    listPlans: () => listFluxPlans(),

    resolvePack,
    resolvePlan,
    getFluxPlanByKey,

    async getProviderAccount(input: { userId: string, provider: PaymentProviderName }) {
      const row = await deps.db.query.providerAccount.findFirst({
        where: and(
          eq(schema.providerAccount.userId, input.userId),
          eq(schema.providerAccount.provider, input.provider),
          isNull(schema.providerAccount.deletedAt),
        ),
      })
      if (!row)
        return null
      return { providerCustomerId: row.providerCustomerId }
    },

    async startPack(input: StartPackInput): Promise<StartPackResult> {
      const adapter = requireProvider(input.provider)
      const pack = await getFluxPackByKey(input.packKey)

      const [order] = await deps.db.insert(schema.paymentOrder).values({
        userId: input.userId,
        provider: input.provider,
        status: 'pending',
        packKey: pack.key,
        fluxAmount: pack.fluxAmount,
        currency: input.startContext.currency,
      }).returning()

      if (!order)
        throw createInternalError('Failed to create payment order')

      const account = await deps.db.query.providerAccount.findFirst({
        where: and(
          eq(schema.providerAccount.userId, input.userId),
          eq(schema.providerAccount.provider, input.provider),
          isNull(schema.providerAccount.deletedAt),
        ),
      })

      const created = await adapter.create({
        kind: 'pack',
        paymentOrderId: order.id,
        userId: input.userId,
        pack,
        currency: input.startContext.currency,
        successUrl: input.startContext.successUrl,
        cancelUrl: input.startContext.cancelUrl,
        customerEmail: input.startContext.customerEmail,
        providerCustomerId: account?.providerCustomerId ?? null,
        metadata: input.startContext.metadata,
      })

      await deps.db.update(schema.paymentOrder)
        .set({
          providerOrderId: created.providerOrderId,
          amount: created.amount,
          currency: created.currency ?? input.startContext.currency,
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.paymentOrder.id, order.id),
          isNull(schema.paymentOrder.providerOrderId),
        ))

      return { kind: 'redirect', url: created.url, paymentOrderId: order.id }
    },

    /**
     * Starts a plan checkout.
     *
     * Ordering: refuse when the user already has an active subscription
     * (409 `ALREADY_SUBSCRIBED`), then create the payment order, then create
     * the provider session.
     */
    async startPlan(input: StartPlanInput): Promise<StartPlanResult> {
      const active = await deps.subscription.getActiveRow(input.userId)
      if (active)
        throw createConflictError('Already subscribed', 'ALREADY_SUBSCRIBED')

      const adapter = requireProvider(input.provider)
      const plan = await getFluxPlanByKey(input.planKey)

      const [order] = await deps.db.insert(schema.paymentOrder).values({
        userId: input.userId,
        provider: input.provider,
        status: 'pending',
        planKey: plan.key,
        fluxAmount: plan.periodQuota,
        currency: input.startContext.currency,
      }).returning()

      if (!order)
        throw createInternalError('Failed to create payment order')

      const account = await deps.db.query.providerAccount.findFirst({
        where: and(
          eq(schema.providerAccount.userId, input.userId),
          eq(schema.providerAccount.provider, input.provider),
          isNull(schema.providerAccount.deletedAt),
        ),
      })

      const created = await adapter.create({
        kind: 'plan',
        paymentOrderId: order.id,
        userId: input.userId,
        plan,
        currency: input.startContext.currency,
        successUrl: input.startContext.successUrl,
        cancelUrl: input.startContext.cancelUrl,
        customerEmail: input.startContext.customerEmail,
        providerCustomerId: account?.providerCustomerId ?? null,
        metadata: input.startContext.metadata,
      })

      await deps.db.update(schema.paymentOrder)
        .set({
          providerOrderId: created.providerOrderId,
          amount: created.amount,
          currency: created.currency ?? input.startContext.currency,
          updatedAt: new Date(),
        })
        .where(and(
          eq(schema.paymentOrder.id, order.id),
          isNull(schema.paymentOrder.providerOrderId),
        ))

      return { kind: 'redirect', url: created.url, paymentOrderId: order.id }
    },

    async applyConfirmation(facts: ConfirmationFacts): Promise<ApplyConfirmationResult> {
      if (facts.paymentOrderId)
        return claimExistingOrder(facts)

      return claimEvidenceOrder(facts)
    },

    /**
     * Records a paid plan invoice and grants/resets period quota.
     * Does not credit Flux balance.
     */
    async applyPlanInvoice(facts: PlanInvoiceFacts): Promise<ApplyPlanInvoiceResult> {
      const userId = await resolveUserIdFromCustomer({
        provider: facts.provider,
        providerCustomerId: facts.providerCustomerId,
        userId: facts.userId,
      })
      if (!userId)
        throw createInternalError('Plan invoice is missing user binding')

      return deps.db.transaction(async (tx) => {
        const [existingOrder] = await tx
          .select({ id: schema.paymentOrder.id, status: schema.paymentOrder.status })
          .from(schema.paymentOrder)
          .where(and(
            eq(schema.paymentOrder.provider, facts.provider),
            eq(schema.paymentOrder.providerOrderId, facts.providerInvoiceId),
          ))
          .limit(1)

        if (existingOrder?.status === 'paid')
          return { applied: false as const }

        const grant = await deps.subscription.grantPeriod({
          userId,
          provider: facts.provider,
          providerSubscriptionId: facts.providerSubscriptionId,
          planKey: facts.planKey,
          periodQuotaAmount: facts.periodQuota,
          providerData: facts.providerData,
          tx,
        })

        if (!grant.granted) {
          logger.withFields({
            userId,
            provider: facts.provider,
            providerSubscriptionId: facts.providerSubscriptionId,
            providerInvoiceId: facts.providerInvoiceId,
          }).warn('Plan invoice not granted: user already has an active subscription')
          return { applied: false as const }
        }

        if (facts.paymentOrderId) {
          const [pending] = await tx
            .select()
            .from(schema.paymentOrder)
            .where(eq(schema.paymentOrder.id, facts.paymentOrderId))
            .for('update')

          if (pending?.status === 'pending') {
            await tx.update(schema.paymentOrder)
              .set({
                status: 'paid',
                creditedAt: new Date(),
                providerOrderId: facts.providerInvoiceId,
                subscriptionId: grant.subscriptionId,
                planKey: facts.planKey,
                fluxAmount: facts.periodQuota,
                amount: facts.amount ?? pending.amount,
                currency: facts.currency ?? pending.currency,
                providerData: facts.providerData ?? pending.providerData,
                updatedAt: new Date(),
              })
              .where(and(
                eq(schema.paymentOrder.id, pending.id),
                eq(schema.paymentOrder.status, 'pending'),
              ))
          }
          else if (!existingOrder) {
            await tx.insert(schema.paymentOrder).values({
              userId,
              provider: facts.provider,
              providerOrderId: facts.providerInvoiceId,
              status: 'paid',
              planKey: facts.planKey,
              fluxAmount: facts.periodQuota,
              subscriptionId: grant.subscriptionId,
              amount: facts.amount,
              currency: facts.currency,
              creditedAt: new Date(),
              providerData: facts.providerData,
            })
          }
        }
        else if (!existingOrder) {
          await tx.insert(schema.paymentOrder).values({
            userId,
            provider: facts.provider,
            providerOrderId: facts.providerInvoiceId,
            status: 'paid',
            planKey: facts.planKey,
            fluxAmount: facts.periodQuota,
            subscriptionId: grant.subscriptionId,
            amount: facts.amount,
            currency: facts.currency,
            creditedAt: new Date(),
            providerData: facts.providerData,
          })
        }

        if (facts.providerCustomerId) {
          await upsertProviderAccount(tx, {
            userId,
            provider: facts.provider,
            providerCustomerId: facts.providerCustomerId,
          })
        }

        return {
          applied: true as const,
          userId,
          subscriptionId: grant.subscriptionId,
          periodQuota: facts.periodQuota,
        }
      })
    },

    async endSubscription(input: {
      provider: PaymentProviderName
      providerSubscriptionId: string
      status?: 'ended' | 'canceled'
    }) {
      return deps.subscription.endAndReclaim(input)
    },

    async cancel(input: { paymentOrderId: string }) {
      const [order] = await deps.db
        .select()
        .from(schema.paymentOrder)
        .where(and(
          eq(schema.paymentOrder.id, input.paymentOrderId),
          isNull(schema.paymentOrder.deletedAt),
        ))
        .limit(1)

      if (!order)
        throw createBadRequestError('Payment order not found', 'PAYMENT_ORDER_NOT_FOUND')

      if (order.status !== 'pending')
        return

      if (order.providerOrderId) {
        const adapter = requireProvider(order.provider as PaymentProviderName)
        await adapter.cancel({ providerOrderId: order.providerOrderId })
      }

      await deps.db.update(schema.paymentOrder)
        .set({ status: 'canceled', updatedAt: new Date() })
        .where(and(
          eq(schema.paymentOrder.id, order.id),
          eq(schema.paymentOrder.status, 'pending'),
        ))
    },

    /**
     * Cancels open provider objects, then soft-deletes orders and accounts.
     * `flux_transaction` is not touched.
     */
    async deleteAllForUser(userId: string) {
      const pending = await deps.db
        .select({
          id: schema.paymentOrder.id,
          provider: schema.paymentOrder.provider,
          providerOrderId: schema.paymentOrder.providerOrderId,
        })
        .from(schema.paymentOrder)
        .where(and(
          eq(schema.paymentOrder.userId, userId),
          inArray(schema.paymentOrder.status, [...OPEN_CHECKOUT_CANCEL_STATUSES]),
          isNull(schema.paymentOrder.deletedAt),
        ))

      for (const order of pending) {
        if (!order.providerOrderId)
          continue
        const adapter = deps.providers[order.provider as PaymentProviderName]
        if (!adapter)
          continue
        await adapter.cancel({ providerOrderId: order.providerOrderId })
      }

      const now = new Date()

      await deps.db.update(schema.paymentOrder)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(
          eq(schema.paymentOrder.userId, userId),
          isNull(schema.paymentOrder.deletedAt),
        ))

      await deps.db.update(schema.providerAccount)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(
          eq(schema.providerAccount.userId, userId),
          isNull(schema.providerAccount.deletedAt),
        ))

      await deps.subscription.deleteAllForUser(userId)

      logger.withFields({ userId, cancelledOrders: pending.length }).log('Payment rows soft-deleted for user')
    },
  }
}

export type PaymentService = ReturnType<typeof createPaymentService>
