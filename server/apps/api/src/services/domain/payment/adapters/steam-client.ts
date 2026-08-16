import { errorMessageFrom } from '@moeru/std'
import { ofetch } from 'ofetch'

import { createInternalError, createServiceUnavailableError } from '../../../../utils/error'

const PARTNER_BASE = 'https://partner.steam-api.com'

export type SteamMicroTxnInterface = 'ISteamMicroTxn' | 'ISteamMicroTxnSandbox'

export type SteamReportType
  = | 'GAMESALES'
    | 'STEAMSTORESALES'
    | 'SETTLEMENT'
    | 'CHARGEBACK'
    | 'SUBSCRIPTION'

export type SteamTxnStatus
  = | 'Init'
    | 'Approved'
    | 'Succeeded'
    | 'Failed'
    | 'Refunded'
    | 'PartialRefund'
    | 'Chargedback'
    | 'RefundedSuspectedFraud'
    | 'RefundedFriendlyFraud'
    | string

export type SteamAgreementStatus = 'Active' | 'Canceled' | 'Processing' | string

export interface SteamReportItem {
  itemid: number
  qty: number
  amount: number
  vat: number
  itemstatus: string
}

export interface SteamReportOrder {
  orderid: string
  transid: string
  steamid: string
  status: SteamTxnStatus
  currency: string
  time: string
  timecreated?: string
  country?: string
  usstate?: string
  agreementid?: string
  agreementstatus?: SteamAgreementStatus
  nextpayment?: string
  items: SteamReportItem[]
}

export interface SteamAgreement {
  agreementid: string
  itemid: number
  status: SteamAgreementStatus
  period?: string
  frequency?: number
  startdate?: string
  enddate?: string
  recurringamt?: number
  currency?: string
  timecreated?: string
  lastpayment?: string
  lastamount?: number
  nextpayment?: string
  outstanding?: number
  failedattempts?: number
}

interface SteamApiError {
  errorcode?: number | string
  errordesc?: string
}

interface SteamEnvelope<TParams> {
  response: {
    result: 'OK' | 'Failure'
    params?: TParams
    error?: SteamApiError
  }
}

export interface SteamMicroTxnClientOptions {
  publisherKey: string
  appId: number
  /**
   * When true, call `ISteamMicroTxnSandbox` instead of production.
   * @default false
   */
  sandbox?: boolean
  /**
   * @default 15_000
   */
  timeoutMs?: number
}

export interface SteamMicroTxnClient {
  initTxn: (input: {
    orderId: string
    steamId: string
    language: string
    currency: string
    itemId: number
    amountCents: number
    description: string
    quantity?: number
    userSession?: 'client' | 'web'
    ipAddress?: string
    billingType?: 'Steam' | 'Game'
    period?: 'Day' | 'Week' | 'Month' | 'Year'
    frequency?: number
    recurringAmountCents?: number
  }) => Promise<{ orderId: string, transId: string, steamUrl?: string }>
  finalizeTxn: (input: { orderId: string }) => Promise<{ orderId: string, transId: string }>
  getReport: (input: {
    time: string
    type?: SteamReportType
    maxResults?: number
  }) => Promise<{ orders: SteamReportOrder[], timeCreated?: string }>
  getUserAgreementInfo: (input: { steamId: string }) => Promise<SteamAgreement[]>
  cancelAgreement: (input: { steamId: string, agreementId: string }) => Promise<void>
}

/**
 * Typed `ofetch` client for Steamworks `ISteamMicroTxn`.
 *
 * Matches the auth Steam OpenID pattern: `ofetch` + timeout, no third-party
 * Steam payment package.
 */
export function createSteamMicroTxnClient(options: SteamMicroTxnClientOptions): SteamMicroTxnClient {
  const iface: SteamMicroTxnInterface = options.sandbox ? 'ISteamMicroTxnSandbox' : 'ISteamMicroTxn'
  const timeout = options.timeoutMs ?? 15_000
  const key = options.publisherKey
  const appid = options.appId

  async function postForm<TParams>(
    method: string,
    version: string,
    body: Record<string, string | number | undefined>,
  ): Promise<TParams> {
    const url = `${PARTNER_BASE}/${iface}/${method}/${version}/`
    const form = new URLSearchParams()
    form.set('key', key)
    form.set('appid', String(appid))
    for (const [name, value] of Object.entries(body)) {
      if (value !== undefined)
        form.set(name, String(value))
    }

    let envelope: SteamEnvelope<TParams>
    try {
      envelope = await ofetch<SteamEnvelope<TParams>>(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        timeout,
      })
    }
    catch (error) {
      throw createServiceUnavailableError(
        `Steam MicroTxn ${method} failed: ${errorMessageFrom(error) ?? 'network error'}`,
        'STEAM_MICROTXN_UNAVAILABLE',
      )
    }

    return unwrap(method, envelope)
  }

  async function getQuery<TParams>(
    method: string,
    version: string,
    query: Record<string, string | number | undefined>,
  ): Promise<TParams> {
    const url = `${PARTNER_BASE}/${iface}/${method}/${version}/`
    let envelope: SteamEnvelope<TParams>
    try {
      envelope = await ofetch<SteamEnvelope<TParams>>(url, {
        method: 'GET',
        query: {
          key,
          appid,
          ...query,
        },
        timeout,
      })
    }
    catch (error) {
      throw createServiceUnavailableError(
        `Steam MicroTxn ${method} failed: ${errorMessageFrom(error) ?? 'network error'}`,
        'STEAM_MICROTXN_UNAVAILABLE',
      )
    }

    return unwrap(method, envelope)
  }

  return {
    async initTxn(input) {
      const quantity = input.quantity ?? 1
      const params = await postForm<{
        orderid: string
        transid: string
        steamurl?: string
      }>('InitTxn', 'v3', {
        'orderid': input.orderId,
        'steamid': input.steamId,
        'itemcount': 1,
        'language': input.language,
        'currency': input.currency,
        'usersession': input.userSession,
        'ipaddress': input.ipAddress,
        'itemid[0]': input.itemId,
        'qty[0]': quantity,
        'amount[0]': input.amountCents,
        'description[0]': input.description.slice(0, 128),
        'billingtype[0]': input.billingType,
        'period[0]': input.period,
        'frequency[0]': input.frequency,
        'recurringamt[0]': input.recurringAmountCents,
      })

      return {
        orderId: String(params.orderid),
        transId: String(params.transid),
        steamUrl: params.steamurl,
      }
    },

    async finalizeTxn(input) {
      const params = await postForm<{ orderid: string, transid: string }>('FinalizeTxn', 'v2', {
        orderid: input.orderId,
      })
      return {
        orderId: String(params.orderid),
        transId: String(params.transid),
      }
    },

    async getReport(input) {
      const params = await getQuery<{
        count?: number
        orders?: SteamReportOrder[]
        timecreated?: string
      }>('GetReport', 'v5', {
        time: input.time,
        type: input.type ?? 'SETTLEMENT',
        maxresults: input.maxResults ?? 1000,
      })

      return {
        orders: params.orders ?? [],
        timeCreated: params.timecreated,
      }
    },

    async getUserAgreementInfo(input) {
      const params = await getQuery<{
        agreements?: {
          agreement?: SteamAgreement | SteamAgreement[]
        }
      }>('GetUserAgreementInfo', 'v2', {
        steamid: input.steamId,
      })

      const raw = params.agreements?.agreement
      if (raw == null)
        return []
      return Array.isArray(raw) ? raw : [raw]
    },

    async cancelAgreement(input) {
      await postForm<{ agreementid: string }>('CancelAgreement', 'v1', {
        steamid: input.steamId,
        agreementid: input.agreementId,
      })
    },
  }
}

function unwrap<TParams>(method: string, envelope: SteamEnvelope<TParams>): TParams {
  if (envelope.response.result === 'OK' && envelope.response.params)
    return envelope.response.params

  const code = envelope.response.error?.errorcode
  const description = envelope.response.error?.errordesc ?? 'Steam MicroTxn failure'
  throw createInternalError(
    `Steam MicroTxn ${method} returned Failure: ${description}`,
    {
      errorCode: 'STEAM_MICROTXN_FAILURE',
      steamErrorCode: code,
      steamErrorDesc: description,
    },
  )
}
