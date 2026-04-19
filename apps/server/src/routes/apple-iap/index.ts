import type { AppleIapService } from '../../services/apple-iap/service'
import type { AppleIapVerifier } from '../../services/apple-iap/verifier'
import type { BillingService } from '../../services/billing/billing-service'
import type { ConfigKVService } from '../../services/config-kv'
import type { HonoEnv } from '../../types/hono'

import { useLogger } from '@guiiai/logg'
import { Hono } from 'hono'
import { v5 as uuidv5 } from 'uuid'
import { safeParse } from 'valibot'

import { authGuard } from '../../middlewares/auth'
import { rateLimiter } from '../../middlewares/rate-limit'
import { APPLE_IAP_NAMESPACE_UUID } from '../../utils/apple-iap'
import { createBadRequestError, createForbiddenError, createServiceUnavailableError } from '../../utils/error'
import { SubmitTransactionBodySchema } from './schema'

const logger = useLogger('apple-iap-routes')

/**
 * Public catalog entry shape returned by `GET /packages` for the iOS client.
 *
 * Kept intentionally tiny — localized price strings come from StoreKit
 * `Product.displayPrice` on the device, not from the server.
 */
interface ApplePackage {
  productId: string
  fluxAmount: number
  label?: string
  recommended?: boolean
}

export function createAppleIapRoutes(
  appleIapService: AppleIapService,
  appleIapVerifier: AppleIapVerifier | null,
  billingService: BillingService,
  configKV: ConfigKVService,
) {
  return new Hono<HonoEnv>()
    /**
     * Public flux package catalog for the iOS build.
     *
     * Mirrors `GET /api/v1/stripe/packages` in purpose but is keyed on
     * App Store Connect `productId` instead of Stripe price ids.
     *
     * Returns an empty array when Apple IAP is not configured for this
     * deployment so the client can fall back to Stripe without crashing
     * on a 5xx / 404.
     */
    .get('/packages', async (c) => {
      const products = await configKV.getOptional('APPLE_IAP_PRODUCTS')
      if (!products || products.length === 0) {
        return c.json<ApplePackage[]>([])
      }
      return c.json<ApplePackage[]>(products.map(p => ({
        productId: p.productId,
        fluxAmount: p.fluxAmount,
        label: p.label,
        recommended: p.recommended,
      })))
    })

    /**
     * Accept a StoreKit 2 JWS from the native plugin, verify it, and
     * idempotently credit flux. This route plays the same role as Stripe's
     * `/webhook` — except the signer is the device and the "webhook secret"
     * is Apple's JWS signature chain verified by `SignedDataVerifier`.
     */
    .post('/transactions', authGuard, rateLimiter({ max: 10, windowSec: 60 }), async (c) => {
      // Short-circuit when `APPLE_BUNDLE_ID` is unset or the Apple Root CA
      // bundle is missing — we can't verify JWS without a verifier, and
      // silently crediting would be a security hole.
      if (!appleIapVerifier) {
        throw createServiceUnavailableError('Apple IAP is not configured', 'APPLE_IAP_DISABLED')
      }

      const user = c.get('user')!
      const body = await c.req.json().catch(() => null)
      if (!body) {
        throw createBadRequestError('Invalid JSON body', 'INVALID_BODY')
      }

      const parsed = safeParse(SubmitTransactionBodySchema, body)
      if (!parsed.success) {
        throw createBadRequestError('Invalid transaction body', 'INVALID_REQUEST', parsed.issues)
      }

      const payload = await appleIapVerifier.verifyTransaction(parsed.output.signedTransaction)

      if (!payload.transactionId) {
        throw createBadRequestError('Transaction payload missing transactionId', 'MISSING_TRANSACTION_ID')
      }
      if (!payload.productId) {
        throw createBadRequestError('Transaction payload missing productId', 'MISSING_PRODUCT_ID')
      }
      if (!payload.originalTransactionId) {
        throw createBadRequestError('Transaction payload missing originalTransactionId', 'MISSING_ORIGINAL_TRANSACTION_ID')
      }
      if (!payload.purchaseDate) {
        throw createBadRequestError('Transaction payload missing purchaseDate', 'MISSING_PURCHASE_DATE')
      }

      // The appAccountToken is generated on-device as uuidv5(userId, NAMESPACE).
      // Verifying this equality prevents a stolen JWS from one account being
      // credited to another session's balance.
      const expectedToken = uuidv5(user.id, APPLE_IAP_NAMESPACE_UUID)
      if (!payload.appAccountToken || payload.appAccountToken.toLowerCase() !== expectedToken.toLowerCase()) {
        logger.withFields({
          userId: user.id,
          transactionId: payload.transactionId,
          actual: payload.appAccountToken,
        }).warn('appAccountToken mismatch')
        throw createForbiddenError('appAccountToken does not match authenticated user', 'ACCOUNT_TOKEN_MISMATCH')
      }

      const products = (await configKV.getOptional('APPLE_IAP_PRODUCTS')) ?? []
      const pkg = products.find(p => p.productId === payload.productId)
      if (!pkg) {
        throw createBadRequestError('Unknown product', 'UNKNOWN_PRODUCT', { productId: payload.productId })
      }

      await appleIapService.upsertTransaction({
        userId: user.id,
        transactionId: payload.transactionId,
        originalTransactionId: payload.originalTransactionId,
        productId: payload.productId,
        bundleId: payload.bundleId ?? '',
        environment: String(payload.environment ?? ''),
        appAccountToken: payload.appAccountToken,
        purchaseDate: new Date(payload.purchaseDate),
        quantity: payload.quantity ?? 1,
        priceMicros: payload.price ?? null,
        currency: payload.currency ?? null,
        fluxAmount: pkg.fluxAmount,
      })

      const result = await billingService.creditFluxFromAppleIapPurchase({
        userId: user.id,
        transactionId: payload.transactionId,
        productId: payload.productId,
        fluxAmount: pkg.fluxAmount,
        priceMicros: payload.price ?? null,
        currency: payload.currency ?? 'USD',
      })

      logger.withFields({
        userId: user.id,
        transactionId: payload.transactionId,
        productId: payload.productId,
        applied: result.applied,
        balanceAfter: result.balanceAfter,
      }).log('Processed Apple IAP transaction')

      return c.json({
        applied: result.applied,
        balanceAfter: result.balanceAfter,
        transactionId: payload.transactionId,
      })
    })
}
