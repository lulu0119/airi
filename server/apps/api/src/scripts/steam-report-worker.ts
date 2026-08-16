#!/usr/bin/env node

/**
 * One-shot Steam GetReport worker for Railway/cron.
 *
 * Call stack:
 *
 * steam-report-worker
 *   -> createApp / injeca resolve
 *   -> {@link createSteamReportWorker}.syncOnce
 *   -> Steam GetReport -> Payment CORE `settle` (evidence)
 *
 * Exit 0 on success. Exit 1 on configuration or Steam failure.
 */

import process from 'node:process'

import { useLogger } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std'

import { createApp } from '../app'
import { createSteamReportWorker } from '../services/domain/payment/workers/steam-report'

async function main(): Promise<void> {
  const logger = useLogger('steam-report-worker')
  const {
    paymentService,
    steamClient,
    db,
    redis,
  } = await createApp()

  if (!steamClient) {
    logger.error('Steam MicroTxn client is not configured (STEAM_PUBLISHER_KEY / STEAM_APP_ID)')
    process.exit(1)
  }

  const worker = createSteamReportWorker({
    client: steamClient,
    payment: paymentService,
    db,
    redis,
  })

  const result = await worker.syncOnce()
  logger.withFields(result).log('Steam GetReport sync finished')
}

void main().catch((error: unknown) => {
  process.stderr.write(`${errorMessageFrom(error) ?? 'Steam report worker failed'}\n`)
  process.exit(1)
})
