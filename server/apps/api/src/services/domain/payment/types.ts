import type { FluxPackListItem, FluxPlanListItem } from '@proj-airi/server-sdk-shared'

export type { FluxPackListItem, FluxPlanListItem }

export const PAYMENT_PROVIDERS = ['stripe', 'apple_iap', 'steam'] as const

export type PaymentProviderName = typeof PAYMENT_PROVIDERS[number]

export const PAYMENT_ORDER_STATUSES = ['pending', 'paid', 'canceled', 'expired'] as const

export type PaymentOrderStatus = typeof PAYMENT_ORDER_STATUSES[number]

export const CONFIRMATION_STATUSES = ['paid', 'canceled', 'expired'] as const

export type ConfirmationStatus = typeof CONFIRMATION_STATUSES[number]

export interface CatalogProviderIds {
  stripe?: { priceId: string }
  appleIap?: { productId: string }
  steam?: { itemId: number }
}

export interface ProviderProductRef {
  provider: PaymentProviderName
  providerProductId: string | number
}

export interface FluxPack {
  key: string
  name: string
  fluxAmount: number
  recommended: boolean
  providers: CatalogProviderIds
}

export interface FluxPlan {
  key: string
  name: string
  periodQuota: number
  periodMonths: number
  recommended: boolean
  providers: CatalogProviderIds
}

/**
 * Formatted money for one Stripe Price id.
 * Display strings never feed checkout; checkout still uses the catalog priceId.
 */
export interface HydratedPrice {
  priceId: string
  defaultCurrency: string
  currencies: Record<string, string>
}

/**
 * Read-only price hydration. Stripe retrieve is true-external;
 * production and test adapters sit at this seam.
 */
export interface DisplayPrice {
  /** Omit ids that cannot be retrieved. Do not throw for a missing price. */
  hydrate: (priceIds: string[]) => Promise<ReadonlyMap<string, HydratedPrice>>
}

export interface PackStartContext {
  currency?: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  metadata?: Record<string, string>
}

export type PlanStartContext = PackStartContext

export interface StartPackInput {
  userId: string
  provider: PaymentProviderName
  packKey: string
  startContext: PackStartContext
}

export interface StartPlanInput {
  userId: string
  provider: PaymentProviderName
  planKey: string
  startContext: PlanStartContext
}

export interface StartPackResult {
  kind: 'redirect'
  url: string
  paymentOrderId: string
}

export type StartPlanResult = StartPackResult

export interface ConfirmationFacts {
  provider: PaymentProviderName
  paymentOrderId?: string
  providerOrderId: string
  status: ConfirmationStatus
  amount?: number
  currency?: string
  providerCustomerId?: string
  providerData?: Record<string, unknown>
  /**
   * Evidence-first channels (Apple IAP) set these when there is no prior
   * pending `payment_order`. CORE inserts-or-claims by `providerOrderId`.
   */
  userId?: string
  packKey?: string
  fluxAmount?: number
}

export type ApplyConfirmationResult
  = | { applied: true, userId: string, fluxAmount: number, balanceAfter: number }
    | { applied: false }

/**
 * Facts for a paid subscription invoice. Grants period quota; does not credit balance.
 */
export interface PlanInvoiceFacts {
  provider: PaymentProviderName
  providerInvoiceId: string
  providerSubscriptionId: string
  providerCustomerId?: string
  userId?: string
  planKey: string
  periodQuota: number
  amount?: number
  currency?: string
  paymentOrderId?: string
  providerData?: Record<string, unknown>
}

export type ApplyPlanInvoiceResult
  = | { applied: true, userId: string, subscriptionId: string, periodQuota: number }
    | { applied: false }

export interface ProviderCreatePackInput {
  kind: 'pack'
  paymentOrderId: string
  userId: string
  pack: FluxPack
  currency?: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  providerCustomerId?: string | null
  metadata?: Record<string, string>
}

export interface ProviderCreatePlanInput {
  kind: 'plan'
  paymentOrderId: string
  userId: string
  plan: FluxPlan
  currency?: string
  successUrl: string
  cancelUrl: string
  customerEmail?: string
  providerCustomerId?: string | null
  metadata?: Record<string, string>
}

export type ProviderCreateInput = ProviderCreatePackInput | ProviderCreatePlanInput

export interface ProviderCreateResult {
  providerOrderId: string
  url: string
  amount?: number
  currency?: string
}

/**
 * Internal Provider seam. Stripe, Apple, and Steam satisfy this.
 *
 * Channel routes call {@link PaymentProvider.confirmed} after they verify
 * the native payload. CORE calls {@link PaymentProvider.create}.
 * Display prices use {@link DisplayPrice}, not this seam.
 */
export interface PaymentProvider {
  create: (input: ProviderCreateInput) => Promise<ProviderCreateResult>
  confirmed: (native: unknown) => ConfirmationFacts
  cancel: (input: { providerOrderId: string }) => Promise<void>
  getStatus: (input: { providerOrderId: string }) => Promise<PaymentOrderStatus | null>
}
