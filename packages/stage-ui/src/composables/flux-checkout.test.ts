import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// NOTICE:
// `Capacitor.getPlatform()` is read at `useFluxCheckout()` construction time,
// which means every test that needs a different platform branch has to set
// `currentPlatform` *before* importing the composable. Because module-level
// `vi.mock` is hoisted, we route getPlatform through a mutable closure so the
// same composable file can be reloaded across tests via `vi.resetModules()`.
let currentPlatform: 'ios' | 'web' | 'android' = 'web'

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => currentPlatform,
  },
}))

// The AppleIap plugin is a thin proxy; every method is driven by its mock so
// we can assert the exact call ordering (getProducts before purchase) and
// verify no Stripe traffic happens on iOS.
const appleIapMocks = {
  configure: vi.fn(async () => {}),
  getProducts: vi.fn(async () => ({ products: [] as any[] })),
  purchase: vi.fn(async () => ({ status: 'success' } as any)),
}

vi.mock('@proj-airi/capacitor-plugin-apple-iap', () => ({
  AppleIap: appleIapMocks,
}))

// Auth store — only `updateCredits` is read by the composable.
const updateCredits = vi.fn(async () => {})
vi.mock('../stores/auth', () => ({
  useAuthStore: () => ({ updateCredits }),
}))

// Hono client mock. Shape mirrors the real chain so we can swap one endpoint
// at a time and assert the Stripe branch never calls the Apple one and vice
// versa.
const stripePackagesGet = vi.fn()
const stripeCheckoutPost = vi.fn()
const appleIapPackagesGet = vi.fn()

vi.mock('./api', () => ({
  client: {
    api: {
      v1: {
        'stripe': {
          packages: { $get: (...args: unknown[]) => stripePackagesGet(...args) },
          checkout: { $post: (...args: unknown[]) => stripeCheckoutPost(...args) },
        },
        'apple-iap': {
          packages: { $get: (...args: unknown[]) => appleIapPackagesGet(...args) },
        },
      },
    },
  },
}))

function jsonResponse<T>(body: T, ok = true) {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  }
}

async function importComposable() {
  // Resetting modules between tests means the composable reads the current
  // value of `currentPlatform` fresh each time.
  vi.resetModules()
  const mod = await import('./flux-checkout')
  return mod.useFluxCheckout
}

beforeEach(() => {
  appleIapMocks.configure.mockClear()
  appleIapMocks.getProducts.mockReset()
  appleIapMocks.purchase.mockReset()
  stripePackagesGet.mockReset()
  stripeCheckoutPost.mockReset()
  appleIapPackagesGet.mockReset()
  updateCredits.mockReset()
})

/**
 * @example
 * describe('useFluxCheckout — iOS branch', () => {
 *   it('merges server packages with StoreKit localized prices', async () => { ... })
 *   it('ignores Stripe endpoints entirely', async () => { ... })
 *   it('refreshes credits after a successful purchase', async () => { ... })
 *   it('maps StoreKit outcomes to the unified PurchaseResult shape', async () => { ... })
 * })
 */
describe('useFluxCheckout — iOS branch', () => {
  beforeEach(() => {
    currentPlatform = 'ios'
  })

  it('reports platform=ios and hides the currency selector', async () => {
    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    expect(ck.platform).toBe('ios')
    expect(ck.supportsCurrencySelection.value).toBe(false)
    expect(ck.currencyOptions.value).toEqual([])
  })

  it('fetchPackages intersects server catalog with StoreKit products and uses native displayPrice', async () => {
    appleIapPackagesGet.mockResolvedValueOnce(jsonResponse([
      { productId: 'flux.pack.1000', fluxAmount: 1000, label: '1000 Flux' },
      { productId: 'flux.pack.3000', fluxAmount: 3000, label: '3000 Flux', recommended: true },
      { productId: 'flux.pack.removed', fluxAmount: 5000, label: 'Removed' },
    ]))
    appleIapMocks.getProducts.mockResolvedValueOnce({
      products: [
        { id: 'flux.pack.1000', displayName: '1000 Flux', displayPrice: '$0.99', description: '', priceMicros: 990000, currencyCode: 'USD' },
        { id: 'flux.pack.3000', displayName: '3000 Flux', displayPrice: '$2.99', description: '', priceMicros: 2990000, currencyCode: 'USD' },
      ],
    })

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    await ck.fetchPackages()

    // Call ordering: server first, StoreKit second. Unknown products are dropped.
    expect(appleIapPackagesGet).toHaveBeenCalledTimes(1)
    expect(appleIapMocks.getProducts).toHaveBeenCalledWith({
      productIds: ['flux.pack.1000', 'flux.pack.3000', 'flux.pack.removed'],
    })
    expect(stripePackagesGet).not.toHaveBeenCalled()

    expect(ck.packages.value).toHaveLength(2)
    expect(ck.packages.value[0]).toMatchObject({
      id: 'flux.pack.1000',
      displayPrice: '$0.99',
      label: '1000 Flux',
    })
    expect(ck.packages.value[1]).toMatchObject({
      id: 'flux.pack.3000',
      displayPrice: '$2.99',
      recommended: true,
    })
  })

  it('purchase() success → refreshes credits and returns status=success', async () => {
    appleIapMocks.purchase.mockResolvedValueOnce({ status: 'success' })

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    const result = await ck.purchase('flux.pack.1000')

    expect(appleIapMocks.purchase).toHaveBeenCalledWith({ productId: 'flux.pack.1000' })
    expect(updateCredits).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ status: 'success' })
    expect(ck.purchasing.value).toBeNull()
    expect(stripeCheckoutPost).not.toHaveBeenCalled()
  })

  it('purchase() userCancelled → status=canceled and no credit refresh', async () => {
    appleIapMocks.purchase.mockResolvedValueOnce({ status: 'userCancelled' })

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    const result = await ck.purchase('flux.pack.1000')

    expect(result).toEqual({ status: 'canceled' })
    expect(updateCredits).not.toHaveBeenCalled()
  })

  it('purchase() pending → status=pending and no credit refresh', async () => {
    appleIapMocks.purchase.mockResolvedValueOnce({ status: 'pending' })

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    const result = await ck.purchase('flux.pack.1000')

    expect(result).toEqual({ status: 'pending' })
    expect(updateCredits).not.toHaveBeenCalled()
  })

  it('purchase() is guarded against concurrent calls', async () => {
    // Hold the first purchase open so the second call overlaps with it.
    let resolveFirst: (v: unknown) => void
    appleIapMocks.purchase.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFirst = resolve as any
    }))

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()

    const first = ck.purchase('flux.pack.1000')
    await nextTick()
    const second = await ck.purchase('flux.pack.1000')
    expect(second.status).toBe('error')

    resolveFirst!({ status: 'success' })
    await first
  })
})

/**
 * @example
 * describe('useFluxCheckout — Stripe branch', () => {
 *   it('reports platform=other and fetches stripe packages', async () => { ... })
 *   it('purchase() redirects to checkout.url and returns status=success + redirecting=true', async () => { ... })
 *   it('purchase() propagates server error messages', async () => { ... })
 * })
 */
describe('useFluxCheckout — Stripe branch', () => {
  beforeEach(() => {
    currentPlatform = 'web'
    vi.stubGlobal('window', { location: { href: '' } })
  })

  it('reports platform=other and resolves Stripe packages', async () => {
    stripePackagesGet.mockResolvedValueOnce(jsonResponse([
      {
        stripePriceId: 'price_1',
        label: '1000 Flux',
        defaultCurrency: 'usd',
        currencies: { usd: '$0.99', eur: '€0.89' },
      },
      {
        stripePriceId: 'price_2',
        label: '3000 Flux',
        defaultCurrency: 'usd',
        currencies: { usd: '$2.99', eur: '€2.79' },
        recommended: true,
      },
    ]))

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    await ck.fetchPackages()

    expect(ck.platform).toBe('other')
    expect(appleIapPackagesGet).not.toHaveBeenCalled()
    expect(appleIapMocks.getProducts).not.toHaveBeenCalled()

    expect(ck.packages.value).toHaveLength(2)
    expect(ck.packages.value[0]).toMatchObject({ id: 'price_1', displayPrice: '$0.99' })
    expect(ck.supportsCurrencySelection.value).toBe(true)
    expect(ck.currencyOptions.value).toEqual([
      { label: 'USD', value: 'usd' },
      { label: 'EUR', value: 'eur' },
    ])
  })

  it('switching selectedCurrency updates the displayed price without a refetch', async () => {
    stripePackagesGet.mockResolvedValueOnce(jsonResponse([
      {
        stripePriceId: 'price_1',
        label: '1000 Flux',
        defaultCurrency: 'usd',
        currencies: { usd: '$0.99', eur: '€0.89' },
      },
    ]))

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    await ck.fetchPackages()

    expect(ck.packages.value[0].displayPrice).toBe('$0.99')
    ck.selectedCurrency.value = 'eur'
    await nextTick()
    expect(ck.packages.value[0].displayPrice).toBe('€0.89')
    expect(stripePackagesGet).toHaveBeenCalledTimes(1)
  })

  it('purchase() navigates to the Stripe URL and returns { status: success, redirecting: true }', async () => {
    stripePackagesGet.mockResolvedValueOnce(jsonResponse([
      {
        stripePriceId: 'price_1',
        label: '1000 Flux',
        defaultCurrency: 'usd',
        currencies: { usd: '$0.99' },
      },
    ]))
    stripeCheckoutPost.mockResolvedValueOnce(jsonResponse({ url: 'https://checkout.stripe.com/c/abc' }))

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    await ck.fetchPackages()

    const result = await ck.purchase('price_1')

    expect(stripeCheckoutPost).toHaveBeenCalledWith({
      json: { stripePriceId: 'price_1', currency: 'usd' },
    })
    expect(result).toEqual({ status: 'success', redirecting: true })
    expect((window as any).location.href).toBe('https://checkout.stripe.com/c/abc')
    expect(appleIapMocks.purchase).not.toHaveBeenCalled()
  })

  it('purchase() propagates server error messages', async () => {
    stripeCheckoutPost.mockResolvedValueOnce(jsonResponse({ message: 'Price is unavailable' }, false))

    const useFluxCheckout = await importComposable()
    const ck = useFluxCheckout()
    const result = await ck.purchase('price_1')

    expect(result.status).toBe('error')
    expect(result.message).toBe('Price is unavailable')
  })
})
