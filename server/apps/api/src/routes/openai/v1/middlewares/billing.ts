import type { RevenueMetrics } from '../../../../otel'
import type { ConfigKVService } from '../../../../services/adapters/config-kv'
import type { UsageInfo } from '../../../../services/domain/billing/billing'
import type { BillingService } from '../../../../services/domain/billing/billing-service'

import { calculateFluxFromUsage } from '../../../../services/domain/billing/billing'
import { GEN_AI_ATTR_REQUEST_MODEL } from '../../../../utils/observability'

export interface ChatFluxDebitInput extends UsageInfo {
  billingService: BillingService
  revenue?: RevenueMetrics | null
  userId: string
  requestId: string
  model: string
  amount: number
  stage: 'streaming' | 'non_streaming'
  logger: {
    withFields: (fields: Record<string, unknown>) => {
      warn: (message: string) => void
    }
  }
}

export interface ChatBillingPolicy {
  fallbackRate: number
  fluxPer1kTokens?: number
}

export interface OpenAiRouteBilling {
  authorizeChat: (userId: string) => Promise<ChatBillingPolicy>
  priceChatUsage: (usage: UsageInfo, policy: ChatBillingPolicy) => number
  recordChatDebitFailure: (input: {
    amount: number
    model: string
    stage: 'streaming' | 'non_streaming'
  }) => void
  settleChat: (input: Omit<ChatFluxDebitInput, 'billingService' | 'revenue'>) => Promise<{ charged: number, source: 'quota' | 'balance' }>
}

export function createOpenAiRouteBilling(deps: {
  billingService: BillingService
  configKV: ConfigKVService
  revenue?: RevenueMetrics | null
}): OpenAiRouteBilling {
  // NOTICE: Billing is best-effort — chat flux is debited AFTER the LLM
  // response is sent. This is a deliberate tradeoff: users get lower latency
  // and uninterrupted streaming, at the cost of a small revenue leak when
  // debit fails (e.g. DB timeout). Failed debits are logged at error level by
  // the settlement call site.
  //
  // Pre-flight gates on `balance >= fallbackRate` (not just `> 0`) because
  // streaming providers that don't echo `usage` cause every billable request
  // to fall back to `FLUX_PER_REQUEST`. Without this gate, a user sitting on
  // `0 < balance < fallbackRate` could spawn N parallel requests that each
  // pass the loose `>0` check, complete the stream, and race on the debit.
  async function authorizeChat(userId: string): Promise<ChatBillingPolicy> {
    const fallbackRate = await deps.configKV.getOrThrow('FLUX_PER_REQUEST')
    const fluxPer1kTokens = await deps.configKV.get('FLUX_PER_1K_TOKENS')

    await deps.billingService.authorizeFluxSpend({
      userId,
      minimumAmount: fallbackRate,
    })

    return { fallbackRate, fluxPer1kTokens }
  }

  function priceChatUsage(usage: UsageInfo, policy: ChatBillingPolicy): number {
    if (policy.fluxPer1kTokens == null)
      return policy.fallbackRate
    return calculateFluxFromUsage(usage, policy.fluxPer1kTokens, policy.fallbackRate)
  }

  async function settleChat(input: Omit<ChatFluxDebitInput, 'billingService' | 'revenue'>): Promise<{ charged: number, source: 'quota' | 'balance' }> {
    return debitChatFlux({
      ...input,
      billingService: deps.billingService,
      revenue: deps.revenue,
    })
  }

  function recordChatDebitFailure(input: {
    amount: number
    model: string
    stage: 'streaming' | 'non_streaming'
  }): void {
    deps.revenue?.fluxUnbilled.add(input.amount, {
      [GEN_AI_ATTR_REQUEST_MODEL]: input.model,
      reason: 'debit_failed',
      stage: input.stage,
    })
  }

  return { authorizeChat, priceChatUsage, recordChatDebitFailure, settleChat }
}

export async function debitChatFlux(input: ChatFluxDebitInput): Promise<{ charged: number, source: 'quota' | 'balance' }> {
  const result = await input.billingService.consumeFluxForLLM({
    userId: input.userId,
    amount: input.amount,
    requestId: input.requestId,
    description: 'llm_request',
    model: input.model,
    promptTokens: input.promptTokens,
    completionTokens: input.completionTokens,
  })

  if (result.charged < result.requested) {
    input.revenue?.fluxUnbilled.add(result.requested - result.charged, {
      [GEN_AI_ATTR_REQUEST_MODEL]: input.model,
      reason: 'partial_debit_drained',
      stage: input.stage,
    })
    input.logger.withFields({
      userId: input.userId,
      requestId: input.requestId,
      requested: result.requested,
      charged: result.charged,
      unbilled: result.requested - result.charged,
    }).warn(input.stage === 'streaming'
      ? 'Partial debit after streaming — flux drained to zero'
      : 'Partial debit on non-streaming completion — flux drained to zero')
  }

  return { charged: result.charged, source: result.source }
}
