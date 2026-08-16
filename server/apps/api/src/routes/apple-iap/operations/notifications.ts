import type { AppleIapVerifier } from '../../../services/domain/payment/adapters/apple-verifier'

import { NotificationTypeV2 } from '@apple/app-store-server-library'
import { useLogger } from '@guiiai/logg'
import { safeParse } from 'valibot'

import { createBadRequestError, createServiceUnavailableError } from '../../../utils/error'
import { AppleNotificationBodySchema } from '../schema'

const logger = useLogger('apple-iap.notifications')

export interface NotificationOperationDeps {
  verifier: AppleIapVerifier | null
}

/**
 * Handles App Store Server Notifications V2.
 *
 * Server contract: return 2xx after the signed payload is accepted. Return 5xx
 * only when Apple must retry. Invalid signatures return 4xx so Apple stops.
 *
 * Pack-only phase: verify and acknowledge every notification. Do not mutate
 * subscription or balance state. REFUND notifications are logged and ignored.
 */
export function createNotificationOperation(deps: NotificationOperationDeps) {
  return async (input: { body: unknown }): Promise<{ received: true }> => {
    if (!deps.verifier)
      throw createServiceUnavailableError('Apple IAP is not configured', 'APPLE_IAP_DISABLED')

    const parsed = safeParse(AppleNotificationBodySchema, input.body)
    if (!parsed.success)
      throw createBadRequestError('Invalid notification body', 'INVALID_REQUEST', parsed.issues)

    const notification = await deps.verifier.verifyNotification(parsed.output.signedPayload)
    const notificationType = notification.notificationType
    const subtype = notification.subtype

    logger.withFields({
      notificationType,
      subtype,
      notificationUUID: notification.notificationUUID,
    }).log('ASSN V2 received')

    switch (notificationType) {
      case NotificationTypeV2.REFUND:
      case NotificationTypeV2.REFUND_DECLINED:
      case NotificationTypeV2.REFUND_REVERSED:
      case NotificationTypeV2.CONSUMPTION_REQUEST: {
        logger.withFields({ notificationType, subtype }).log('Ignoring Apple refund-shaped notification')
        return { received: true }
      }
      case NotificationTypeV2.EXPIRED:
      case NotificationTypeV2.REVOKE:
      case NotificationTypeV2.SUBSCRIBED:
      case NotificationTypeV2.DID_RENEW:
      case NotificationTypeV2.OFFER_REDEEMED:
      case NotificationTypeV2.DID_FAIL_TO_RENEW:
      case NotificationTypeV2.DID_CHANGE_RENEWAL_STATUS:
      case NotificationTypeV2.DID_CHANGE_RENEWAL_PREF:
      case NotificationTypeV2.GRACE_PERIOD_EXPIRED:
      case NotificationTypeV2.PRICE_INCREASE:
      case NotificationTypeV2.RENEWAL_EXTENDED:
      case NotificationTypeV2.RENEWAL_EXTENSION:
      case NotificationTypeV2.TEST:
      case NotificationTypeV2.EXTERNAL_PURCHASE_TOKEN:
      case NotificationTypeV2.ONE_TIME_CHARGE:
      case NotificationTypeV2.RESCIND_CONSENT:
      case NotificationTypeV2.METADATA_UPDATE:
      case NotificationTypeV2.MIGRATION:
      case NotificationTypeV2.PRICE_CHANGE: {
        logger.withFields({ notificationType, subtype }).log('ASSN lifecycle notification acknowledged without local mutation')
        return { received: true }
      }
      default: {
        logger.withFields({ notificationType }).log('Ignoring unhandled ASSN V2 type')
        return { received: true }
      }
    }
  }
}
