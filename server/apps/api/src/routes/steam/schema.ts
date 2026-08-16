import { object, optional, picklist, string } from 'valibot'

export const SyncReportBodySchema = object({
  type: optional(picklist([
    'GAMESALES',
    'STEAMSTORESALES',
    'SETTLEMENT',
    'CHARGEBACK',
  ])),
  time: optional(string()),
})
