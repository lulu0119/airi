# Apple In-App Purchase (StoreKit 2, direct)

AIRI's iOS build tops up Flux with **consumable** App Store products instead
of Stripe. There is no third-party broker (no RevenueCat, no custom storefront)
— the device obtains a JWS transaction from StoreKit 2, POSTs it to the AIRI
server, and the server does cryptographic verification and idempotent
crediting before the device calls `transaction.finish()`.

This document covers the server side. Client/native-plugin details live in
`packages/capacitor-plugin-apple-iap/README.md` and
`apps/stage-pocket/README.md`.

## Scope (match Stripe, not a superset)

Implemented:

- Consumable one-time Flux packages (`flux.pack.*`).
- JWS signature verification against the Apple Root CA chain.
- Idempotent flux credit (one JWS = one credit, replays return `applied:false`).
- `apple-iap.purchase.completed` billing event on Redis Streams.

**Deliberately not implemented** (same reasoning as the plan — avoid scope
creep beyond what Stripe does today):

- No App Store Server Notifications V2 webhook. Client-driven JWS submission
  is enough for one-shot consumables; we will add ASSN V2 only when we ship
  subscriptions or refunds.
- No subscriptions / auto-renewing products. No `apple_iap_subscription` table.
- No refund or family-sharing revocation write-backs.
- No raw JWS column. We store only the decoded payload fields we need.
- No order history, account center, or "restore purchases" UI — consumable
  purchases are not restorable under Apple's own policy.

## Route surface

All routes are mounted at `/api/v1/apple-iap`.

The route group is **always** registered so the Hono client `AppType` is stable.
When `APPLE_BUNDLE_ID` is unset or the Apple Root CA bundle is missing,
`appleIapVerifier` is `null`: `POST /transactions` responds with
`503 APPLE_IAP_DISABLED` instead of crediting without verification.
`GET /packages` still returns the catalog whenever `APPLE_IAP_PRODUCTS` is set.

### `GET /packages`

Public. Returns the catalog configured in `configKV` under `APPLE_IAP_PRODUCTS`:

```ts
[
  { productId: 'flux.pack.1000', fluxAmount: 1000, label: '1000 Flux' },
  { productId: 'flux.pack.3000', fluxAmount: 3000, label: '3000 Flux', recommended: true },
]
```

Empty array when the config key is unset — the client treats this as "Apple
IAP not available in this deployment" and shows nothing.

Localized price strings are **not** served from here. They come from
`Product.displayPrice` on the device via
`AppleIap.getProducts({ productIds })`. The server never needs to know the
actual price paid — it only needs to know the flux amount associated with
a `productId`.

### `POST /transactions` (auth required, rate-limited 10/60s)

Body: `{ signedTransaction: string }` — a JWS transaction from the native
plugin.

The handler does, in order:

1. Verify the JWS via `AppleIapVerifier.verifyTransaction(jws)` (wraps
   `SignedDataVerifier` from `@apple/app-store-server-library`). Any signature
   chain / decode error becomes a 400 with an error code such as
   `JWS_VERIFICATION_FAILED` or `BUNDLE_MISMATCH`.
2. Check required payload fields: `transactionId`, `productId`,
   `originalTransactionId`, `purchaseDate`.
3. Require `payload.appAccountToken` to equal `uuidv5(user.id, APPLE_IAP_NAMESPACE_UUID)`
   (case-insensitive). Mismatch → 403 `ACCOUNT_TOKEN_MISMATCH`. This is the
   only thing that binds a JWS to a specific AIRI account; without it, a
   stolen JWS could be credited to any authenticated session.
4. Look up the `productId` in `APPLE_IAP_PRODUCTS`. Unknown → 400
   `UNKNOWN_PRODUCT`.
5. `appleIapService.upsertTransaction(...)` — row in `apple_iap_transaction`
   with `fluxCredited: false` if not already present.
6. `billingService.creditFluxFromAppleIapPurchase(...)` — atomic claim: only
   the first caller flipping `fluxCredited: false → true` inside a DB
   transaction actually writes `flux_transaction` and publishes the billing
   events. Replays return `{ applied: false }`.
7. Response: `{ applied, balanceAfter?, transactionId }`.

The native client **only** calls `transaction.finish()` after this endpoint
returns 2xx. Transient 5xx responses are survived by the normal StoreKit 2
re-delivery: the next app launch replays the JWS via `Transaction.unfinished`
and the idempotent claim makes replays safe.

## Data model

### `apple_iap_transaction` (one row per verified JWS)

See `apps/server/src/schemas/apple-iap.ts`. Highlights:

- `transaction_id` — UNIQUE. This is Apple's `transactionId` and the
  deduplication key.
- `original_transaction_id` — stored for future subscription work; unused
  today.
- `environment` — `'Sandbox'` or `'Production'`. Sandbox and production
  JWS live in the same table; filter on this column if you need to exclude
  sandbox.
- `app_account_token` — exactly the value verified against `uuidv5(user.id, NS)`.
  Kept for audit, not re-derived at read time.
- `price_micros` — StoreKit 2 `price` is a micro-unit integer (e.g. `990000`
  for `$0.99`). `null` when the payload omits it (older StoreKit versions,
  some promo flows).
- `flux_amount` — snapshot at claim time. Decoupled from the `configKV` entry
  so a later catalog change does not retroactively rewrite past credits.
- `flux_credited` — the idempotency flag flipped atomically inside the DB
  transaction.

No FK on `product_id` → `configKV`; the config key is free-form JSON.

## Idempotency: how the atomic claim works

Inside `creditFluxFromAppleIapPurchase` we run, in a single DB transaction:

```sql
UPDATE apple_iap_transaction
   SET flux_credited = true, updated_at = now()
 WHERE transaction_id = $1
   AND flux_credited = false
RETURNING *;
```

If `RETURNING` is empty the row was already credited — we immediately return
`{ applied: false }` without touching `user_flux` / `flux_transaction`. If
`RETURNING` yields a row, that caller has exclusive ownership of the credit
operation for that `transactionId` and proceeds to the same `user_flux
FOR UPDATE` → `INSERT flux_transaction` path used by Stripe.

## Billing event

After a successful credit:

- `flux.credited` (shared across all credit sources)
- `apple-iap.purchase.completed` (payload: `{ transactionId, productId, amount, currency }` — `amount` is `priceMicros` or `0` when absent)

Both are fire-and-forget on `billing-events` Redis Stream and today have no
downstream consumer beyond the catch-all logger. Add handlers the same way
you would for `stripe.checkout.completed`.

## `appAccountToken` contract

The server generates the expected token with:

```ts
import { APPLE_IAP_NAMESPACE_UUID } from 'apps/server/src/utils/apple-iap'
import { v5 as uuidv5 } from 'uuid'

const expected = uuidv5(user.id, APPLE_IAP_NAMESPACE_UUID)
```

The iOS client generates it the same way and calls
`Product.PurchaseOption.appAccountToken(UUID(uuidString: ...))` before
presenting the purchase sheet. The two sides **must** use the exact same
namespace UUID literal. It is hardcoded — do not move it to env/config.
Rotating it invalidates every in-flight transaction, so only change it
together with a coordinated client + server release.

## Config & env

- `APPLE_BUNDLE_ID` — production App Store Connect bundle, e.g.
  `ai.moeru.airi-pocket`. Required for `SignedDataVerifier` to construct.
- `APPLE_IAP_ENV` — `sandbox` (default), `production`, or `xcode`. Use
  `xcode` for local Xcode StoreKit Configuration files; the Apple verifier
  treats those JWS payloads as non-App-Store-signed local test data.
- `configKV.APPLE_IAP_PRODUCTS` — catalog (see above). Seeded manually.

Apple Root CA bundle lives at `apps/server/assets/apple-root-ca/`. The
G2 and G3 `.cer` files ship with the repo. If they are missing the verifier
refuses to start and `POST /transactions` short-circuits with 503.

## Testing

- `apps/server/src/routes/apple-iap/route.test.ts` mocks `SignedDataVerifier`
  and covers: signature failure / bundle mismatch / `appAccountToken`
  mismatch / unknown product / happy path / idempotent replay.
- `apps/server/src/services/billing/tests/billing-service.apple-iap.test.ts`
  covers the atomic claim in isolation.
- End-to-end sandbox verification uses Xcode's StoreKit Configuration File
  plus a Sandbox Apple ID. Documented in `apps/stage-pocket/README.md`.
  Not wired into CI.
