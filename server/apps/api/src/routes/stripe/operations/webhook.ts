import type Stripe from 'stripe'

import type { RevenueMetrics } from '../../../otel'
import type { ConfigKVService } from '../../../services/adapters/config-kv'
import type { PaymentProvider, PaymentService } from '../../../services/domain/payment'
import type { ProductEventService } from '../../../services/domain/product-events'

import { useLogger } from '@guiiai/logg'

import { createBadRequestError, createServiceUnavailableError } from '../../../utils/error'
import { errorMessageFromUnknown } from '../../../utils/error-message'

const logger = useLogger('stripe')

export interface WebhookOperationDeps {
  stripe: Stripe | null
  webhookSecret: string | undefined
  stripeAdapter: PaymentProvider
  payment: PaymentService
  configKV: ConfigKVService
  metrics?: RevenueMetrics | null
  productEventService?: ProductEventService
}

export interface WebhookOperationInput {
  signature: string | null
  body: string
}

/**
 * Verifies a Stripe webhook, maps native events through the Stripe adapter /
 * Payment CORE. Pack checkouts credit balance; plan invoices grant period quota.
 */
export function createWebhookOperation(deps: WebhookOperationDeps) {
  return async (input: WebhookOperationInput): Promise<{ received: true }> => {
    if (!deps.stripe || !deps.webhookSecret)
      throw createServiceUnavailableError('Stripe is not configured', 'STRIPE_NOT_CONFIGURED')

    if (!input.signature)
      throw createBadRequestError('No signature', 'MISSING_SIGNATURE')

    let event: Stripe.Event
    try {
      event = deps.stripe.webhooks.constructEvent(input.body, input.signature, deps.webhookSecret)
    }
    catch (err: unknown) {
      throw createBadRequestError(`Webhook Error: ${errorMessageFromUnknown(err)}`, 'WEBHOOK_ERROR')
    }

    logger.withFields({ type: event.type, id: event.id }).log('Webhook event received')
    deps.metrics?.stripeEvents.add(1, { event_type: event.type })

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        if (session.mode !== 'payment') {
          // Subscription first payment is fulfilled by invoice.paid.
          logger.withFields({ sessionId: session.id, mode: session.mode }).log('Ignoring non-payment checkout session')
          break
        }

        const facts = deps.stripeAdapter.confirmed(session)
        const result = await deps.payment.applyConfirmation(facts)
        deps.metrics?.stripeCheckoutCompleted.add(1)
        if (session.amount_total != null && session.currency) {
          deps.metrics?.stripeRevenue.add(session.amount_total, {
            currency: session.currency,
            source: 'checkout',
          })
        }
        if (result.applied) {
          const posthogDistinctId = session.metadata?.posthogDistinctId
          const posthogSessionId = session.metadata?.posthogSessionId
          void deps.productEventService?.track({
            userId: result.userId,
            feature: 'billing',
            action: 'payment_completed',
            status: 'succeeded',
            source: 'stripe.webhook',
            metadata: {
              amount_total: session.amount_total,
              currency: session.currency,
              flux_amount: result.fluxAmount,
              pack_key: session.metadata?.packKey ?? null,
              stripe_checkout_session_id: session.id,
              stripe_customer_id: typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null,
              ...(posthogDistinctId && { posthog_distinct_id: posthogDistinctId }),
              ...(posthogSessionId && { posthog_session_id: posthogSessionId }),
            },
          })
        }
        break
      }
      case 'checkout.session.expired': {
        const facts = deps.stripeAdapter.confirmed(event.data.object)
        await deps.payment.applyConfirmation(facts)
        break
      }
      case 'invoice.paid': {
        await handleInvoicePaid(deps, event.data.object)
        break
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        await deps.payment.endSubscription({
          provider: 'stripe',
          providerSubscriptionId: subscription.id,
          status: 'ended',
        })
        deps.metrics?.stripeSubscriptionEvent.add(1, { event_type: event.type })
        break
      }
      case 'customer.subscription.updated': {
        const subscription = event.data.object
        // past_due: keep quota (OpenCode / D9). incomplete_expired ends below.
        if (subscription.status === 'incomplete_expired') {
          await deps.payment.endSubscription({
            provider: 'stripe',
            providerSubscriptionId: subscription.id,
            status: 'ended',
          })
        }
        deps.metrics?.stripeSubscriptionEvent.add(1, { event_type: event.type })
        break
      }
      case 'customer.subscription.created':
      case 'invoice.created':
      case 'invoice.updated':
      case 'invoice.payment_failed': {
        logger.withFields({ type: event.type, id: event.id }).log('Ignoring subscription lifecycle noise')
        break
      }
      default:
        break
    }

    return { received: true }
  }
}

async function handleInvoicePaid(deps: WebhookOperationDeps, invoice: Stripe.Invoice) {
  const subscriptionId = readInvoiceSubscriptionId(invoice)

  if (!subscriptionId) {
    logger.withFields({ invoiceId: invoice.id }).log('Ignoring invoice.paid without subscription')
    return
  }

  if (!deps.stripe) {
    logger.withFields({ invoiceId: invoice.id }).warn('Stripe client missing for invoice.paid')
    return
  }

  const customerId = typeof invoice.customer === 'string'
    ? invoice.customer
    : invoice.customer && typeof invoice.customer === 'object' && 'id' in invoice.customer
      ? invoice.customer.id
      : undefined

  let planKey: string | undefined
  let paymentOrderId: string | undefined
  let userId: string | undefined
  let priceId: string | undefined

  try {
    const stripeSubscription = await deps.stripe.subscriptions.retrieve(subscriptionId)
    planKey = stripeSubscription.metadata?.planKey || undefined
    paymentOrderId = stripeSubscription.metadata?.payment_order_id || undefined
    userId = stripeSubscription.metadata?.userId || undefined
    priceId = stripeSubscription.items.data[0]?.price?.id
  }
  catch (error) {
    logger.withError(error).withFields({ subscriptionId }).warn('Failed to load Stripe subscription for invoice.paid')
  }

  let plan
  if (planKey) {
    plan = await deps.payment.getFluxPlanByKey(planKey)
  }
  else {
    const providerProductId = priceId ?? readInvoiceLinePriceId(invoice)
    plan = providerProductId
      ? await deps.payment.resolvePlan({ provider: 'stripe', providerProductId })
      : null
  }

  if (!plan) {
    logger.withFields({ invoiceId: invoice.id, subscriptionId }).warn('invoice.paid missing planKey mapping')
    return
  }

  const result = await deps.payment.applyPlanInvoice({
    provider: 'stripe',
    providerInvoiceId: invoice.id,
    providerSubscriptionId: subscriptionId,
    providerCustomerId: customerId,
    userId,
    planKey: plan.key,
    periodQuota: plan.periodQuota,
    amount: invoice.amount_paid ?? undefined,
    currency: invoice.currency ?? undefined,
    paymentOrderId,
    providerData: {
      invoiceId: invoice.id,
      subscriptionId,
      customerId,
      billingReason: invoice.billing_reason,
    },
  })

  if (result.applied) {
    deps.metrics?.stripeCheckoutCompleted.add(1)
    if (invoice.amount_paid != null && invoice.currency) {
      deps.metrics?.stripeRevenue.add(invoice.amount_paid, {
        currency: invoice.currency,
        source: 'subscription',
      })
    }
    void deps.productEventService?.track({
      userId: result.userId,
      feature: 'billing',
      action: invoice.billing_reason === 'subscription_create' ? 'subscription_started' : 'subscription_renewed',
      status: 'succeeded',
      source: 'stripe.webhook',
      metadata: {
        plan_key: plan.key,
        period_quota: result.periodQuota,
        stripe_invoice_id: invoice.id,
        stripe_subscription_id: subscriptionId,
      },
    })
  }
}

function readInvoiceSubscriptionId(invoice: Stripe.Invoice): string | undefined {
  const withSubscription = invoice as Stripe.Invoice & {
    subscription?: string | { id: string } | null
    parent?: { subscription_details?: { subscription?: string | { id: string } | null } } | null
  }

  const direct = withSubscription.subscription
  if (typeof direct === 'string')
    return direct
  if (direct && typeof direct === 'object' && 'id' in direct)
    return direct.id

  const nested = withSubscription.parent?.subscription_details?.subscription
  if (typeof nested === 'string')
    return nested
  if (nested && typeof nested === 'object' && 'id' in nested)
    return nested.id

  return undefined
}

function readInvoiceLinePriceId(invoice: Stripe.Invoice): string | undefined {
  const line = invoice.lines?.data?.[0] as { price?: string | { id?: string } | null } | undefined
  const linePrice = line?.price
  if (typeof linePrice === 'string')
    return linePrice
  if (linePrice && typeof linePrice === 'object')
    return linePrice.id
  return undefined
}
