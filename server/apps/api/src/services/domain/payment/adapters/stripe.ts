import type Stripe from 'stripe'

import type { ConfigKVService } from '../../../adapters/config-kv'
import type { ConfirmationFacts, FluxPack, FluxPackListItem, PaymentProvider, ProviderCreateInput, ProviderCreateResult } from '../types'

import { useLogger } from '@guiiai/logg'
import { array, looseObject, nullable, number, optional, safeParse, string, union } from 'valibot'

import { createBadRequestError, createInternalError, createServiceUnavailableError } from '../../../../utils/error'

const logger = useLogger('payment.stripe')

type CheckoutSessionCreateParams = NonNullable<Parameters<Stripe['checkout']['sessions']['create']>[0]>

/**
 * Stripe adapter for the Payment Provider port.
 *
 * Checkout create and native-to-facts mapping live here. Signature verify and
 * Customer Portal stay in the Stripe route.
 */
export function createStripePaymentProvider(
  stripe: Stripe | null,
  configKV: ConfigKVService,
): PaymentProvider {
  return {
    async listPackages(packs: FluxPack[]): Promise<FluxPackListItem[]> {
      if (!stripe)
        return []

      const items: FluxPackListItem[] = []
      for (const pack of packs) {
        const priceId = pack.providers.stripe?.priceId
        if (!priceId)
          continue

        let price: Stripe.Price
        try {
          price = await stripe.prices.retrieve(priceId, { expand: ['currency_options'] })
        }
        catch (error) {
          logger.withError(error).withFields({ priceId, packKey: pack.key }).warn('Stripe price lookup skipped')
          continue
        }

        const currencies: Record<string, string> = {}
        currencies[price.currency] = formatPrice(price.unit_amount, price.currency)
        for (const [currency, option] of Object.entries(price.currency_options ?? {})) {
          currencies[currency] = formatPrice(option.unit_amount, currency)
        }

        items.push({
          packKey: pack.key,
          stripePriceId: price.id,
          label: pack.name,
          defaultCurrency: price.currency,
          currencies,
          recommended: pack.recommended,
        })
      }

      return items
    },

    async create(input: ProviderCreateInput): Promise<ProviderCreateResult> {
      if (!stripe)
        throw createServiceUnavailableError('Stripe is not configured', 'STRIPE_NOT_CONFIGURED')

      switch (input.kind) {
        case 'pack':
          return createPackCheckout(stripe, configKV, input)
        case 'plan':
          return createPlanCheckout(stripe, configKV, input)
        default: {
          const exhaustive: never = input
          throw createInternalError(`Unhandled provider create kind: ${String(exhaustive)}`)
        }
      }
    },

    confirmed(native: unknown): ConfirmationFacts {
      const session = native as Stripe.Checkout.Session
      const providerCustomerId = typeof session.customer === 'string'
        ? session.customer
        : session.customer?.id

      const status = session.status === 'expired' ? 'expired' : 'paid'

      return {
        provider: 'stripe',
        paymentOrderId: session.metadata?.payment_order_id || undefined,
        providerOrderId: session.id,
        status,
        amount: session.amount_total ?? undefined,
        currency: session.currency ?? undefined,
        providerCustomerId,
        providerData: {
          sessionId: session.id,
          customerId: providerCustomerId,
          paymentIntentId: typeof session.payment_intent === 'string'
            ? session.payment_intent
            : session.payment_intent?.id,
          mode: session.mode,
          paymentStatus: session.payment_status,
        },
      }
    },

    async cancel(input) {
      if (!stripe)
        return

      try {
        await stripe.checkout.sessions.expire(input.providerOrderId)
      }
      catch (error) {
        logger.withError(error).withFields({ providerOrderId: input.providerOrderId }).warn('Stripe checkout expire skipped')
      }
    },

    async getStatus() {
      return null
    },
  }
}

const stripeIdSchema = union([
  string(),
  looseObject({ id: string() }),
])

const invoicePaidSchema = looseObject({
  id: string(),
  customer: optional(nullable(stripeIdSchema)),
  amount_paid: optional(nullable(number())),
  currency: optional(nullable(string())),
  billing_reason: optional(nullable(string())),
  created: optional(nullable(number())),
  status_transitions: optional(nullable(looseObject({
    paid_at: optional(nullable(number())),
  }))),
  subscription: optional(nullable(stripeIdSchema)),
  parent: optional(nullable(looseObject({
    subscription_details: optional(nullable(looseObject({
      subscription: optional(nullable(stripeIdSchema)),
    }))),
  }))),
  lines: optional(nullable(looseObject({
    data: optional(array(looseObject({
      price: optional(nullable(union([
        string(),
        looseObject({ id: optional(string()) }),
      ]))),
      pricing: optional(nullable(looseObject({
        price_details: optional(nullable(looseObject({
          price: optional(string()),
        }))),
      }))),
    }))),
  }))),
})

export interface InvoicePaidFacts {
  invoiceId: string
  subscriptionId?: string
  customerId?: string
  providerProductId?: string
  amount?: number
  currency?: string
  billingReason?: string
  createdAt?: number
  paidAt?: number
}

const subscriptionEventSchema = looseObject({
  id: string(),
  status: optional(nullable(string())),
})

export interface SubscriptionEventFacts {
  providerSubscriptionId: string
  status?: string
}

/**
 * Maps Stripe `customer.subscription.*` to domain facts.
 * Named export (not PaymentProvider): Apple/Steam have no Stripe subscription object.
 */
export function subscriptionEvent(payload: unknown): SubscriptionEventFacts {
  const parsed = safeParse(subscriptionEventSchema, payload)
  if (!parsed.success)
    throw createBadRequestError('Invalid Stripe subscription payload', 'INVALID_SUBSCRIPTION')

  return {
    providerSubscriptionId: parsed.output.id,
    status: parsed.output.status ?? undefined,
  }
}

/**
 * Maps Stripe `invoice.paid` to domain facts.
 * Named export (not PaymentProvider): Apple/Steam have no invoice object.
 */
export function invoicePaid(payload: unknown): InvoicePaidFacts {
  const parsed = safeParse(invoicePaidSchema, payload)
  if (!parsed.success)
    throw createBadRequestError('Invalid Stripe invoice payload', 'INVALID_INVOICE')

  const invoice = parsed.output
  const firstLine = invoice.lines?.data?.[0]
  const linePrice = firstLine?.price
  const linePriceId = typeof linePrice === 'string'
    ? linePrice
    : linePrice?.id
  const nestedPriceId = firstLine?.pricing?.price_details?.price

  return {
    invoiceId: invoice.id,
    subscriptionId: readStripeId(invoice.subscription)
      ?? readStripeId(invoice.parent?.subscription_details?.subscription),
    customerId: readStripeId(invoice.customer),
    providerProductId: linePriceId ?? nestedPriceId,
    amount: invoice.amount_paid ?? undefined,
    currency: invoice.currency ?? undefined,
    billingReason: invoice.billing_reason ?? undefined,
    createdAt: invoice.created ?? undefined,
    paidAt: invoice.status_transitions?.paid_at ?? undefined,
  }
}

function readStripeId(value: string | { id: string } | null | undefined): string | undefined {
  if (typeof value === 'string' && value.length > 0)
    return value
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.length > 0)
    return value.id
  return undefined
}

async function createPackCheckout(
  stripe: Stripe,
  configKV: ConfigKVService,
  input: Extract<ProviderCreateInput, { kind: 'pack' }>,
): Promise<ProviderCreateResult> {
  const priceId = input.pack.providers.stripe?.priceId
  if (!priceId)
    throw createServiceUnavailableError('Stripe pack mapping is missing', 'STRIPE_PACK_NOT_MAPPED', { packKey: input.pack.key })

  const paymentMethods = await configKV.getOptional('STRIPE_PAYMENT_METHODS')
  const paymentMethodOptions = await configKV.getOptional('STRIPE_PAYMENT_METHOD_OPTIONS') ?? {}

  const sessionParams: CheckoutSessionCreateParams = {
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'payment',
    allow_promotion_codes: true,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer: input.providerCustomerId ?? undefined,
    customer_email: input.providerCustomerId ? undefined : input.customerEmail,
    metadata: {
      payment_order_id: input.paymentOrderId,
      userId: input.userId,
      packKey: input.pack.key,
      fluxAmount: String(input.pack.fluxAmount),
      ...input.metadata,
    },
  }

  if (paymentMethods)
    sessionParams.payment_method_types = paymentMethods as CheckoutSessionCreateParams['payment_method_types']

  if (Object.keys(paymentMethodOptions).length > 0)
    sessionParams.payment_method_options = paymentMethodOptions as CheckoutSessionCreateParams['payment_method_options']

  if (input.currency)
    sessionParams.currency = input.currency

  const session = await stripe.checkout.sessions.create(sessionParams)
  if (!session.url)
    throw createServiceUnavailableError('Stripe checkout did not return a URL', 'STRIPE_CHECKOUT_URL_MISSING')

  return {
    providerOrderId: session.id,
    url: session.url,
    amount: session.amount_total ?? undefined,
    currency: session.currency ?? undefined,
  }
}

async function createPlanCheckout(
  stripe: Stripe,
  configKV: ConfigKVService,
  input: Extract<ProviderCreateInput, { kind: 'plan' }>,
): Promise<ProviderCreateResult> {
  const priceId = input.plan.providers.stripe?.priceId
  if (!priceId)
    throw createServiceUnavailableError('Stripe plan mapping is missing', 'STRIPE_PLAN_NOT_MAPPED', { planKey: input.plan.key })

  const paymentMethods = await configKV.getOptional('STRIPE_PAYMENT_METHODS')
  const paymentMethodOptions = await configKV.getOptional('STRIPE_PAYMENT_METHOD_OPTIONS') ?? {}

  const sessionParams: CheckoutSessionCreateParams = {
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    allow_promotion_codes: true,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    customer: input.providerCustomerId ?? undefined,
    customer_email: input.providerCustomerId ? undefined : input.customerEmail,
    metadata: {
      payment_order_id: input.paymentOrderId,
      userId: input.userId,
      planKey: input.plan.key,
      periodQuota: String(input.plan.periodQuota),
      ...input.metadata,
    },
    subscription_data: {
      metadata: {
        payment_order_id: input.paymentOrderId,
        userId: input.userId,
        planKey: input.plan.key,
        periodQuota: String(input.plan.periodQuota),
      },
    },
  }

  if (paymentMethods)
    sessionParams.payment_method_types = paymentMethods as CheckoutSessionCreateParams['payment_method_types']

  if (Object.keys(paymentMethodOptions).length > 0)
    sessionParams.payment_method_options = paymentMethodOptions as CheckoutSessionCreateParams['payment_method_options']

  if (input.currency)
    sessionParams.currency = input.currency

  const session = await stripe.checkout.sessions.create(sessionParams)
  if (!session.url)
    throw createServiceUnavailableError('Stripe checkout did not return a URL', 'STRIPE_CHECKOUT_URL_MISSING')

  return {
    providerOrderId: session.id,
    url: session.url,
    amount: session.amount_total ?? undefined,
    currency: session.currency ?? undefined,
  }
}

/**
 * Formats a Stripe smallest-unit amount into a display price string.
 *
 * @example
 * formatPrice(300, 'usd') // => '$3.00'
 * formatPrice(500, 'jpy') // => '¥500'
 */
function formatPrice(unitAmount: number | null, currency: string): string {
  if (unitAmount == null)
    return currency.toUpperCase()

  try {
    const formatter = new Intl.NumberFormat('en-US', { style: 'currency', currency })
    const fractionDigits = formatter.resolvedOptions().minimumFractionDigits ?? 2
    const amount = unitAmount / (10 ** fractionDigits)
    return formatter.format(amount)
  }
  catch {
    return `${unitAmount / 100} ${currency.toUpperCase()}`
  }
}
