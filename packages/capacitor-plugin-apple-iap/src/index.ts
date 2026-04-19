import { registerPlugin } from '@capacitor/core'

/**
 * A StoreKit 2 product returned by the native layer.
 *
 * Use when:
 * - Rendering the Flux package grid on iOS so the UI can display the exact,
 *   App Store-localized price string.
 *
 * Expects:
 * - The product has been configured in App Store Connect and is loadable by
 *   StoreKit. Unknown product IDs are silently dropped by `getProducts`.
 */
export interface AppleProduct {
  /** Product identifier, e.g. `flux.pack.1000`. */
  id: string
  /** Localized display name from App Store Connect. */
  displayName: string
  /** Localized description from App Store Connect. */
  description: string
  /** Preformatted localized price, e.g. `$0.99`. Always prefer over `price + currencyCode` for rendering. */
  displayPrice: string
  /** Raw price encoded in micros (1e6 units) to preserve fractional precision across the JS bridge. */
  priceMicros: number
  /** ISO 4217 currency code, e.g. `USD`. */
  currencyCode: string
}

/**
 * Outcome of a single `purchase()` call.
 *
 * Use when:
 * - Updating the UI after a user-initiated buy action.
 *
 * Expects:
 * - `status === 'success'` implies the server has already atomically credited
 *   Flux **and** the transaction has already been finished on StoreKit's side.
 *   `balanceAfter` reflects the authoritative post-credit balance from the server.
 * - `status === 'userCancelled'` means the user cancelled the purchase sheet.
 * - `status === 'pending'` means StoreKit returned `.pending` (e.g. Ask-to-Buy).
 *   The pending transaction will surface again via the native
 *   `Transaction.updates` listener once resolved; no further JS action needed.
 */
export interface PurchaseOutcome {
  status: 'success' | 'userCancelled' | 'pending'
  /**
   * Whether the server actually applied this transaction.
   *
   * `true` on first credit, `false` on an idempotent replay of a previously
   * credited transaction. Only populated when `status === 'success'`.
   */
  applied?: boolean
  /** Post-credit balance from the server. Only populated when `status === 'success'`. */
  balanceAfter?: number
  /** StoreKit 2 transaction identifier. Only populated when `status === 'success'`. */
  transactionId?: string
}

/**
 * Configuration required for the native plugin to talk to the AIRI server.
 *
 * Use when:
 * - The user has just signed in, or a cached session has been restored on
 *   cold start, or the bearer token has been refreshed.
 *
 * Expects:
 * - `serverBaseUrl` is the absolute origin (no trailing slash) where the
 *   `/api/v1/apple-iap/transactions` endpoint lives.
 * - `bearerToken` is the currently valid better-auth session token to send as
 *   `Authorization: Bearer <token>` on every POST.
 * - `appAccountToken` is a UUID (v4 or v5) that the server must be able to
 *   derive/validate from the authenticated user. In AIRI we use
 *   `uuidv5(userId, APPLE_IAP_NAMESPACE_UUID)` on both sides.
 *
 * Calling `configure` more than once atomically replaces the previous
 * configuration. The first call also starts the long-lived
 * `Transaction.updates` listener and drains `Transaction.unfinished`.
 */
export interface AppleIapConfigureOptions {
  serverBaseUrl: string
  bearerToken: string
  appAccountToken: string
}

/**
 * Capacitor plugin interface for Apple IAP (StoreKit 2, consumables only).
 *
 * Use when:
 * - The current platform is iOS. On other platforms, these methods will
 *   reject with a Capacitor "plugin not available" error.
 *
 * Expects:
 * - `configure` is called before `purchase` and before any pending
 *   transactions can be drained.
 */
export interface AppleIapPlugin {
  /**
   * Store the server endpoint, bearer token, and app account token, and start
   * the `Transaction.updates` listener on first call.
   */
  configure: (options: AppleIapConfigureOptions) => Promise<void>

  /**
   * Load StoreKit 2 products by identifier.
   *
   * Returns a `{ products }` object. Unknown product IDs are silently omitted.
   */
  getProducts: (options: { productIds: string[] }) => Promise<{ products: AppleProduct[] }>

  /**
   * Present the StoreKit purchase sheet for a single product and, on success,
   * POST the signed JWS transaction to the server, finish the transaction,
   * and return the outcome.
   */
  purchase: (options: { productId: string }) => Promise<PurchaseOutcome>
}

/**
 * Registered Apple IAP plugin.
 *
 * The plugin name `AppleIap` must match `@objc(AppleIapPlugin)` / `jsName`
 * on the native side.
 */
// NOTICE:
// The explicit `: AppleIapPlugin` annotation is required so tsdown preserves
// the full method signatures in the emitted `.d.mts`. Without it, the
// generic return type of `registerPlugin<T>` is reduced to `any` by the
// declaration-only build and every consumer loses IntelliSense / typecheck
// coverage on `AppleIap.getProducts`, `AppleIap.purchase`, etc.
// Root cause: `registerPlugin` is re-exported from `@capacitor/core` with a
// conditional return type tsdown does not inline during isolated
// declarations emit.
// Removal condition: remove the annotation only after verifying that
// `pnpm -F @proj-airi/capacitor-plugin-apple-iap build` produces a
// `dist/index.d.mts` containing `declare const AppleIap: AppleIapPlugin`.
export const AppleIap: AppleIapPlugin = registerPlugin<AppleIapPlugin>('AppleIap')
