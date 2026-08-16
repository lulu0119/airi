export const PAYMENT_PROVIDERS = ['stripe', 'apple_iap', 'steam', 'fake'] as const

export type PaymentProviderName = typeof PAYMENT_PROVIDERS[number]

export const PAYMENT_ORDER_STATUSES = ['pending', 'paid', 'canceled', 'expired'] as const

export type PaymentOrderStatus = typeof PAYMENT_ORDER_STATUSES[number]

export const CONFIRMATION_STATUSES = ['paid', 'canceled', 'expired'] as const

export type ConfirmationStatus = typeof CONFIRMATION_STATUSES[number]

export interface FluxPack {
  key: string
  name: string
  fluxAmount: number
  recommended: boolean
  providers: {
    stripe?: { priceId: string }
  }
}

export interface FluxPackListItem {
  packKey: string
  stripePriceId?: string
  label: string
  defaultCurrency: string
  currencies: Record<string, string>
  recommended: boolean
}

export interface FluxPlan {
  key: string
  name: string
  periodQuota: number
  periodMonths: number
  recommended: boolean
  defaultCurrency: string
  displayPrices: Record<string, string>
  providers: {
    stripe?: { priceId: string }
  }
}

export interface FluxPlanListItem {
  planKey: string
  stripePriceId?: string
  label: string
  periodQuota: number
  periodMonths: number
  defaultCurrency: string
  currencies: Record<string, string>
  recommended: boolean
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
 * Internal Provider seam. Stripe and Fake satisfy this.
 *
 * Channel routes call {@link PaymentProvider.confirmed} after they verify
 * the native payload. CORE calls {@link PaymentProvider.create}.
 */
export interface PaymentProvider {
  create: (input: ProviderCreateInput) => Promise<ProviderCreateResult>
  listPackages: (packs: FluxPack[]) => Promise<FluxPackListItem[]>
  confirmed: (native: unknown) => ConfirmationFacts
  cancel: (input: { providerOrderId: string }) => Promise<void>
  getStatus: (input: { providerOrderId: string }) => Promise<PaymentOrderStatus | null>
}
