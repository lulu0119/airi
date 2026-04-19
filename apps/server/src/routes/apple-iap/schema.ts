import { minLength, object, pipe, string } from 'valibot'

/**
 * Request body accepted by `POST /api/v1/apple-iap/transactions`.
 *
 * The iOS client extracts `verification.jwsRepresentation` from StoreKit 2's
 * `VerificationResult<Transaction>` and sends it in `signedTransaction`.
 * Server-side verification happens in `createAppleIapVerifier` before any
 * billing state mutation.
 */
export const SubmitTransactionBodySchema = object({
  signedTransaction: pipe(string(), minLength(1, 'signedTransaction is required')),
})
