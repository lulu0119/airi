/**
 * Namespace UUID used to derive a deterministic `appAccountToken` from the
 * authenticated user id via uuidv5.
 *
 * Use when:
 * - The server route needs to verify the `appAccountToken` embedded in a
 *   signed StoreKit 2 transaction belongs to the currently authenticated user.
 * - The iOS client side derives the same token before calling
 *   `AppleIap.configure`.
 *
 * Expects:
 * - This value is also hardcoded in `apps/stage-pocket/src/modules/apple-iap.ts`.
 *   Do not rotate this constant without a coordinated client+server release —
 *   a change invalidates in-flight transactions and breaks idempotent replay.
 */
export const APPLE_IAP_NAMESPACE_UUID = 'f4e8a0c2-2c6b-4e1b-b2a5-6d7f3b5a8c91' as const
