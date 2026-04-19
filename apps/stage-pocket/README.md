<h1 align="center">アイリ VTuber</h1>

<p align="center">
  [<a href="https://airi.ayaka.io">Try it</a>]
</p>

> Heavily inspired by [Neuro-sama](https://www.youtube.com/@Neurosama)

## WebSocket Bridge

Stage Pocket adds a host-backed WebSocket bridge for `@proj-airi/server-sdk`.

Design constraints:
- keep page loading on secure origins (`https` or app-hosted local origins) to preserve secure-context web APIs
- only implement the WebSocket bridge needed by `@proj-airi/server-sdk`
- native owns socket I/O; `server-sdk` owns reconnect, heartbeat, authentication, and connection state
- the bridge only forwards `connect`, `send`, `close`, `open`, `message`, `error`, and `close`

## Apple IAP sandbox verification

iOS builds top up Flux with consumable App Store products via StoreKit 2. End-to-end, a single purchase flows: StoreKit purchase sheet → native plugin extracts the JWS → `POST /api/v1/apple-iap/transactions` → server verifies signature and credits Flux idempotently → native calls `transaction.finish()` only on 2xx. The loop is validated manually against a sandbox account — it is **not** run in CI.

Prerequisites:

- An Apple Developer account with the bundle id (default `ai.moeru.airi-pocket`) and the Flux products (`flux.pack.*`) configured in App Store Connect, **or** an Xcode StoreKit Configuration File for local-only iteration.
- A Sandbox Apple ID signed into **Settings → App Store → Sandbox Account** on the test device / simulator.
- Server-side `APPLE_BUNDLE_ID` set and `configKV.APPLE_IAP_PRODUCTS` seeded to include the product ids you're about to buy. See [`apps/server/docs/ai-context/apple-iap.md`](../server/docs/ai-context/apple-iap.md).

Run the sandbox loop:

1. Open `apps/stage-pocket/ios/App/App.xcworkspace` in Xcode.
2. Add / select a StoreKit Configuration File (scheme → Run → Options → StoreKit Configuration) if you want to iterate without round-tripping App Store Connect.
3. Build & run on a real device or simulator signed into the Sandbox Apple ID.
4. In-app, open **Settings → Flux**, sign in, and tap a package. Approve the purchase in the StoreKit sheet.
5. Confirm that:
   - the Flux balance increases by the amount configured for that `productId`
   - the transaction appears in Apple's sandbox dashboard as Finished
   - the server has a new `apple_iap_transaction` row with `flux_credited = true`
6. Kill and relaunch the app. The balance must **not** change — this validates idempotency end to end.
7. Simulate "server is down" by pausing the backend before the next buy. StoreKit should keep the transaction unfinished; after the server comes back and the app is relaunched, the plugin drains `Transaction.unfinished` and credits exactly once.

If the buy fails with `APPLE_IAP_DISABLED` / 503, either `APPLE_BUNDLE_ID` is unset on the server or the Apple Root CA bundle at `apps/server/assets/apple-root-ca/` is missing.
