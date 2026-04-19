import type { Ref } from 'vue'

import { Capacitor } from '@capacitor/core'
import { errorMessageFrom } from '@moeru/std'
import { AppleIap } from '@proj-airi/capacitor-plugin-apple-iap'
import { computed, ref } from 'vue'

import { useAuthStore } from '../stores/auth'
import { client } from './api'

/**
 * Platform the user is checking out on.
 *
 * `ios` forces the Apple IAP branch (StoreKit 2 + server JWS verification).
 * Everything else falls through to the Stripe Checkout branch.
 */
export type FluxCheckoutPlatform = 'ios' | 'other'

/**
 * Unified Flux package shape consumed by the settings UI.
 *
 * Use when:
 * - Rendering the Flux package grid on any platform.
 *
 * Expects:
 * - `id` is the stable identifier the UI passes back into `purchase(id)` —
 *   Stripe `priceId` off iOS, App Store Connect `productId` on iOS.
 * - `displayPrice` is the string shown to the user. On iOS it's StoreKit's
 *   localized price. On Stripe it's derived from `currencies[selectedCurrency]`
 *   (or `defaultCurrency` when the selection isn't available).
 * - `currencies` / `defaultCurrency` are only populated on the Stripe branch.
 *   The iOS branch does not expose a currency selector: App Store pricing is
 *   region-bound.
 */
export interface FluxPackage {
  id: string
  label: string
  displayPrice: string
  recommended?: boolean
  currencies?: Record<string, string>
  defaultCurrency?: string
}

/**
 * Outcome of one `purchase()` call, flattened so the caller only has to
 * distinguish the three user-visible terminal states.
 *
 * - `success`: funds have been credited server-side (Stripe) OR the Apple
 *   purchase has been verified and finished server-side (iOS). Caller should
 *   refresh credits and show a success toast.
 * - `pending`: iOS-only. Purchase is awaiting Ask-to-Buy or a deferred payment
 *   method. Caller shows a "pending" notice. The native listener will credit
 *   the account in the background when Apple finalizes the transaction.
 * - `canceled`: user cancelled the purchase sheet (iOS) or the checkout page
 *   (Stripe query-string).
 * - `error`: anything else — network, verification, unknown product, etc.
 *   `message` is best-effort and localized by the caller.
 *
 * `redirecting` is `true` when the current document is about to be replaced
 * by the Stripe hosted checkout page. The caller should assume no further
 * JS will run in this tab.
 */
export interface PurchaseResult {
  status: 'success' | 'pending' | 'canceled' | 'error'
  redirecting?: boolean
  message?: string
}

interface StripePackageDTO {
  stripePriceId: string
  label: string
  defaultCurrency: string
  currencies: Record<string, string>
  recommended?: boolean
}

interface ApplePackageDTO {
  productId: string
  fluxAmount: number
  label?: string
  recommended?: boolean
}

/**
 * Unified Flux checkout flow across Stripe (web/desktop) and Apple IAP (iOS).
 *
 * Use when:
 * - Rendering the Flux top-up page. All platform branching, localized
 *   pricing lookup, and idempotent crediting live behind this composable.
 *
 * Call stack (iOS):
 *
 *   fetchPackages
 *     -> GET /api/v1/apple-iap/packages
 *     -> AppleIap.getProducts({ productIds })   // StoreKit 2 local prices
 *     -> FluxPackage[]
 *
 *   purchase(productId)
 *     -> AppleIap.purchase({ productId })       // native: sheet + JWS POST + finish
 *     -> authStore.updateCredits()
 *     -> PurchaseResult
 *
 * Call stack (non-iOS):
 *
 *   fetchPackages
 *     -> GET /api/v1/stripe/packages
 *     -> FluxPackage[]
 *
 *   purchase(priceId)
 *     -> POST /api/v1/stripe/checkout
 *     -> window.location.href = data.url        // browser leaves the SPA
 *     -> PurchaseResult { status: 'success', redirecting: true }
 */
export function useFluxCheckout() {
  const authStore = useAuthStore()

  // Capacitor reports 'web' on browsers / Electron; anything else is native.
  // We only treat iOS specially because Apple Pay / IAP compliance is iOS-only.
  const platform: FluxCheckoutPlatform
    = Capacitor.getPlatform() === 'ios' ? 'ios' : 'other'

  const packages = ref<FluxPackage[]>([]) as Ref<FluxPackage[]>
  const selectedCurrency = ref<string>('usd')
  const loading = ref(false)
  const purchasing = ref<string | null>(null)
  const error = ref<string | null>(null)

  const supportsCurrencySelection = computed(() => {
    if (platform === 'ios')
      return false
    if (packages.value.length === 0)
      return false
    const first = Object.keys(packages.value[0].currencies ?? {})
    return first.filter(c => packages.value.every(p => !!p.currencies && c in p.currencies)).length > 1
  })

  const currencyOptions = computed<{ label: string, value: string }[]>(() => {
    if (platform === 'ios' || packages.value.length === 0)
      return []
    const first = Object.keys(packages.value[0].currencies ?? {})
    return first
      .filter(c => packages.value.every(p => !!p.currencies && c in p.currencies))
      .map(c => ({ label: c.toUpperCase(), value: c }))
  })

  function priceForStripe(pkg: FluxPackage): string {
    if (!pkg.currencies || !pkg.defaultCurrency)
      return pkg.displayPrice
    return pkg.currencies[selectedCurrency.value] ?? pkg.currencies[pkg.defaultCurrency] ?? pkg.displayPrice
  }

  // When the currency changes on Stripe, the rendered `displayPrice` should
  // follow. Recompute on read via a computed list the UI can v-for over.
  const packagesForDisplay = computed<FluxPackage[]>(() => {
    if (platform === 'ios')
      return packages.value
    return packages.value.map(p => ({ ...p, displayPrice: priceForStripe(p) }))
  })

  async function fetchPackagesApple(): Promise<FluxPackage[]> {
    const res = await client.api.v1['apple-iap'].packages.$get()
    if (!res.ok)
      throw new Error(`apple-iap/packages ${res.status}`)

    const serverPkgs = await res.json() as ApplePackageDTO[]
    if (serverPkgs.length === 0)
      return []

    // StoreKit only returns products that are loadable against the current
    // App Store account / region. Missing IDs are silently dropped by Apple,
    // so we intersect by id below to keep the grid consistent.
    const { products } = await AppleIap.getProducts({
      productIds: serverPkgs.map(p => p.productId),
    })
    const byId = new Map(products.map(p => [p.id, p]))

    return serverPkgs
      .filter(p => byId.has(p.productId))
      .map((p) => {
        const sk = byId.get(p.productId)!
        return {
          id: p.productId,
          label: p.label ?? sk.displayName,
          displayPrice: sk.displayPrice,
          recommended: p.recommended,
        }
      })
  }

  async function fetchPackagesStripe(): Promise<FluxPackage[]> {
    const res = await client.api.v1.stripe.packages.$get()
    if (!res.ok)
      throw new Error(`stripe/packages ${res.status}`)

    const data = await res.json() as StripePackageDTO[]
    if (data.length > 0)
      selectedCurrency.value = data[0].defaultCurrency

    return data.map(p => ({
      id: p.stripePriceId,
      label: p.label,
      displayPrice: p.currencies[p.defaultCurrency] ?? '',
      recommended: p.recommended,
      currencies: p.currencies,
      defaultCurrency: p.defaultCurrency,
    }))
  }

  async function fetchPackages(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      packages.value = platform === 'ios'
        ? await fetchPackagesApple()
        : await fetchPackagesStripe()
    }
    catch (e) {
      error.value = errorMessageFrom(e) ?? null
      packages.value = []
    }
    finally {
      loading.value = false
    }
  }

  async function purchaseApple(productId: string): Promise<PurchaseResult> {
    const outcome = await AppleIap.purchase({ productId })
    if (outcome.status === 'userCancelled')
      return { status: 'canceled' }
    if (outcome.status === 'pending')
      return { status: 'pending' }

    // Native side already POSTed the JWS and only resolves 'success' after
    // a 2xx from the server — flux is already credited. Just refresh the
    // locally cached balance so the UI updates immediately.
    await authStore.updateCredits()
    return { status: 'success' }
  }

  async function purchaseStripe(priceId: string): Promise<PurchaseResult> {
    const res = await client.api.v1.stripe.checkout.$post({
      json: { stripePriceId: priceId, currency: selectedCurrency.value },
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { message?: string }
      return { status: 'error', message: data.message }
    }

    const data = await res.json() as { url?: string }
    if (!data.url)
      return { status: 'error' }

    // Hosted Stripe Checkout — the SPA is about to be torn down and the
    // success/cancel query params will be handled on the return trip.
    window.location.href = data.url
    return { status: 'success', redirecting: true }
  }

  async function purchase(id: string): Promise<PurchaseResult> {
    if (purchasing.value)
      return { status: 'error', message: 'busy' }

    purchasing.value = id
    try {
      return platform === 'ios'
        ? await purchaseApple(id)
        : await purchaseStripe(id)
    }
    catch (e) {
      return { status: 'error', message: errorMessageFrom(e) ?? undefined }
    }
    finally {
      purchasing.value = null
    }
  }

  return {
    platform,
    packages: packagesForDisplay,
    loading,
    purchasing,
    error,
    selectedCurrency,
    currencyOptions,
    supportsCurrencySelection,
    fetchPackages,
    purchase,
  }
}
