import { minLength, object, pipe, string } from 'valibot'

/**
 * Body for `POST /api/v1/apple-iap/transactions`.
 *
 * The client sends StoreKit 2 `verification.jwsRepresentation`.
 */
export const SubmitTransactionBodySchema = object({
  signedTransaction: pipe(string(), minLength(1, 'signedTransaction is required')),
})

/**
 * Body for `POST /api/v1/apple-iap/notifications` (ASSN V2).
 *
 * Apple posts `{ signedPayload }` as the notification body.
 */
export const AppleNotificationBodySchema = object({
  signedPayload: pipe(string(), minLength(1, 'signedPayload is required')),
})
