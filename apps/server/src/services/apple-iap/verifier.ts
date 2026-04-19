import type { JWSTransactionDecodedPayload } from '@apple/app-store-server-library'

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Environment, SignedDataVerifier } from '@apple/app-store-server-library'
import { useLogger } from '@guiiai/logg'

import { createBadRequestError } from '../../utils/error'

const logger = useLogger('apple-iap-verifier')

export type AppleIapEnv = 'sandbox' | 'production'

export interface AppleIapVerifierOptions {
  /** App Store bundle identifier, e.g. `ai.moeru.airi-pocket`. */
  bundleId: string
  /** Target App Store environment — determines how `payload.environment` is cross-checked. */
  env: AppleIapEnv
  /** Optional override of the Apple Root CA directory; defaults to `apps/server/assets/apple-root-ca/`. */
  rootCertificatesDir?: string
}

/**
 * Create an Apple IAP JWS verifier.
 *
 * Use when:
 * - Wiring the Apple IAP route in `app.ts`. The verifier must be loaded
 *   once at startup — reading the root CAs from disk on every request
 *   would be wasteful and Apple rotates them very infrequently.
 *
 * Expects:
 * - `bundleId` matches the iOS bundle identifier shipped in the app.
 * - `env` reflects the environment the app is built for. Sandbox verifiers
 *   also accept `Xcode` and `LocalTesting` payload environments so that
 *   Xcode StoreKit Configuration File purchases continue to work against
 *   a staging server.
 *
 * Returns:
 * - `verifyTransaction(jws)` — decodes and verifies a signed StoreKit 2
 *   transaction and cross-checks its `environment` and `bundleId` fields.
 *   Throws `ApiError(400)` on any verification or cross-check failure so
 *   the route can pass the error through Hono's `onError` untouched.
 */
export async function createAppleIapVerifier(options: AppleIapVerifierOptions) {
  const rootCertificatesDir = options.rootCertificatesDir ?? defaultRootCertificatesDir()
  const rootCertificates = await loadAppleRootCertificates(rootCertificatesDir)
  if (rootCertificates.length === 0) {
    throw new Error(`No Apple Root CA .cer files found in ${rootCertificatesDir}`)
  }

  const verifier = new SignedDataVerifier(
    rootCertificates,
    // NOTICE:
    // Keep revocation/expiration online checks disabled. Apple's CA OCSP endpoints
    // are occasionally slow and our JWS processing path is on the critical purchase
    // flow where an extra HTTP call would tighten the user-perceived latency budget.
    // Root certs are refreshed manually via apps/server/assets/apple-root-ca/README.md.
    false,
    options.env === 'production' ? Environment.PRODUCTION : Environment.SANDBOX,
    options.bundleId,
  )

  /**
   * Verify + decode a single signed transaction JWS. Rejects any payload
   * where:
   * - the JWS is malformed / signature is invalid (VerificationException)
   * - `bundleId` does not match the configured bundle
   * - `environment` is not acceptable for the configured env
   */
  async function verifyTransaction(jws: string): Promise<JWSTransactionDecodedPayload> {
    let payload: JWSTransactionDecodedPayload
    try {
      payload = await verifier.verifyAndDecodeTransaction(jws)
    }
    catch (error) {
      logger.withError(error).warn('JWS verification failed')
      throw createBadRequestError('Signed transaction failed verification', 'JWS_VERIFICATION_FAILED')
    }

    if (!payload.bundleId || payload.bundleId !== options.bundleId) {
      throw createBadRequestError('Bundle identifier mismatch', 'BUNDLE_MISMATCH', {
        expected: options.bundleId,
        actual: payload.bundleId,
      })
    }

    if (!isEnvironmentAcceptable(payload.environment, options.env)) {
      throw createBadRequestError('Transaction environment mismatch', 'ENVIRONMENT_MISMATCH', {
        expected: options.env,
        actual: payload.environment,
      })
    }

    return payload
  }

  return { verifyTransaction }
}

export type AppleIapVerifier = Awaited<ReturnType<typeof createAppleIapVerifier>>

/**
 * In sandbox mode, also accept Xcode StoreKit Configuration and LocalTesting
 * payloads so CI/dev builds do not need to be re-signed against a fresh App
 * Store Connect entry to run smoke tests.
 */
function isEnvironmentAcceptable(actual: string | undefined, env: AppleIapEnv): boolean {
  if (env === 'production') {
    return actual === Environment.PRODUCTION
  }
  return actual === Environment.SANDBOX
    || actual === Environment.XCODE
    || actual === Environment.LOCAL_TESTING
}

async function loadAppleRootCertificates(dir: string): Promise<Buffer[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  }
  catch (error) {
    logger.withError(error).withField('dir', dir).error('Failed to read Apple Root CA directory')
    return []
  }

  const cerFiles = entries.filter(name => name.endsWith('.cer'))
  return Promise.all(cerFiles.map(name => readFile(join(dir, name))))
}

function defaultRootCertificatesDir(): string {
  // apps/server/src/services/apple-iap/verifier.ts -> apps/server/assets/apple-root-ca
  return fileURLToPath(new URL('../../../assets/apple-root-ca', import.meta.url))
}
