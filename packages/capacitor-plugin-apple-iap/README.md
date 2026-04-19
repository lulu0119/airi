# @proj-airi/capacitor-plugin-apple-iap

Minimal Capacitor plugin that bridges **StoreKit 2** one-time (consumable) purchases into the AIRI Flux billing pipeline.

## What it does

- Native (Swift) side owns everything StoreKit-related:
  - `Product.purchase()`
  - Extraction of the signed JWS transaction
  - `Transaction.updates` long-lived listener + `Transaction.unfinished` drain on configure
  - POST of the JWS to the AIRI server's `/api/v1/apple-iap/transactions` endpoint
  - Calling `transaction.finish()` **only after** the server returns 2xx
- JS surface is intentionally tiny: three methods, zero events. JWS strings never cross the JS bridge.

## JS API

```ts
import { AppleIap } from '@proj-airi/capacitor-plugin-apple-iap'

await AppleIap.configure({
  serverBaseUrl: 'https://api.airi.example',
  bearerToken: session.token,
  appAccountToken: 'uuid-v5-derived-from-user-id',
})

const { products } = await AppleIap.getProducts({
  productIds: ['flux.pack.1000', 'flux.pack.3000'],
})

const outcome = await AppleIap.purchase({ productId: 'flux.pack.1000' })
// { status: 'success', applied: true, balanceAfter: 1234, transactionId: '...' }
```

## Invariants

- `finish()` is **only** called when the server responds with `applied: true` (first credit) or HTTP 2xx with `applied: false` (already credited — idempotent replay).
- On 5xx / network error, the transaction is left **unfinished**. StoreKit 2 will re-deliver it via `Transaction.updates` on the next session, and the server's unique `transaction_id` + `fluxCredited` atomic claim guarantees at-most-once credit.
- On 4xx (bundle mismatch, unknown product, token mismatch), the transaction is still finished to avoid a death loop, and the error is logged. These should only happen with a misconfigured build.

## When to use

- `apps/stage-pocket` iOS build to satisfy Apple App Store IAP compliance.

## When not to use

- Anywhere else. Stripe remains the payment channel for `stage-web` and `stage-tamagotchi`.
- Subscriptions, refunds, family-sharing revocations, Android Play Billing — out of scope here.
