import { defineInvokeEventa, defineOutboundEventa } from '@moeru/eventa'

export interface WireMessage {
  id: string
  chatId: string
  senderId: string | null
  role: 'system' | 'user' | 'assistant' | 'tool' | 'error'
  content: string
  seq: number
  createdAt: number
  updatedAt: number
}

export type MessageRole = WireMessage['role']

export interface SendMessagesRequest {
  chatId: string
  messages: { id: string, role: string, content: string }[]
}

export interface SendMessagesResponse {
  seq: number
}

export interface PullMessagesRequest {
  chatId: string
  afterSeq: number
  limit?: number
}

export interface PullMessagesResponse {
  messages: WireMessage[]
  seq: number
}

export interface NewMessagesPayload {
  chatId: string
  messages: WireMessage[]
  fromSeq: number
  toSeq: number
}

export const sendMessages = defineInvokeEventa<SendMessagesResponse, SendMessagesRequest>('chat:send-messages')
export const pullMessages = defineInvokeEventa<PullMessagesResponse, PullMessagesRequest>('chat:pull-messages')
export const newMessages = defineOutboundEventa<NewMessagesPayload>('chat:new-messages')

/**
 * Stripe pack card returned by `GET /api/v1/stripe/packages`.
 *
 * NOTICE:
 * Hand-written DTO: Hono InferResponseType hits the TypeScript recursion limit.
 * Source: Stripe packages route types.
 * Removal: when InferResponseType typechecks again.
 */
export interface FluxPackListItem {
  packKey: string
  stripePriceId?: string
  label: string
  defaultCurrency: string
  currencies: Record<string, string>
  recommended: boolean
}

/**
 * Stripe plan card returned by `GET /api/v1/stripe/plans`.
 *
 * NOTICE:
 * Hand-written DTO: Hono InferResponseType hits the TypeScript recursion limit.
 * Source: Stripe plans route types.
 * Removal: when InferResponseType typechecks again.
 */
export interface FluxPlanListItem {
  planKey: string
  stripePriceId?: string
  label: string
  periodQuota: number
  periodMonths: number
  defaultCurrency: string
  currencies: Record<string, string>
  recommended: boolean
}

/**
 * Active subscription counters returned inside `GET /api/v1/flux/stats`.
 *
 * NOTICE:
 * Hand-written DTO: Hono InferResponseType hits the TypeScript recursion limit.
 * Source: flux stats route types.
 * Removal: when InferResponseType typechecks again.
 */
export interface FluxSubscriptionStats {
  planKey: string
  provider: string
  periodQuotaRemaining: number
  periodQuotaTotal: number
  resetAt: string
  useBalance: boolean
}
