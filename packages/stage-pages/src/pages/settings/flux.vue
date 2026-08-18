<script setup lang="ts">
import type { FluxPackListItem, FluxPlanListItem, FluxSubscriptionStats } from '@proj-airi/server-sdk-shared'
import type { FluxBalanceBucket } from '@proj-airi/stage-ui/composables/use-analytics'

import { isFluxPurchaseDisabled, isStageTamagotchi } from '@proj-airi/stage-shared'
import { client } from '@proj-airi/stage-ui/composables/api'
import { useAnalytics } from '@proj-airi/stage-ui/composables/use-analytics'
import { useAuthStore } from '@proj-airi/stage-ui/stores/auth'
import { Button, FieldCheckbox, GhostButton, SelectTab } from '@proj-airi/ui'
import { useEventListener } from '@vueuse/core'
import { storeToRefs } from 'pinia'
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const { credits } = storeToRefs(authStore)
const {
  trackCheckoutStarted,
  trackPaywallSeen,
  trackPlanSelected,
  trackPricingViewed,
  trackQuotaLimitReached,
  trackUpgradeClicked,
} = useAnalytics()

const fluxPurchaseDisabled = isFluxPurchaseDisabled()

// NOTICE:
// Prefer these hand-written DTOs over Hono InferResponseType.
// InferResponseType on Stripe/flux routes hits the TypeScript recursion limit.
// Source: packages/server-sdk-shared Flux* exports.
// Removal: when InferResponseType typechecks again.

interface AuditRecord {
  id: string
  type: string
  amount: number
  description: string
  metadata: Record<string, unknown> | null
  createdAt: string
  billingSource?: 'balance' | 'quota' | null
}

const loadingPackKey = ref<string | null>(null)
const loadingPlanKey = ref<string | null>(null)
const managingPortal = ref(false)
const useBalanceUpdating = ref(false)
const message = ref<{ type: 'success' | 'error', text: string } | null>(null)
const checkoutReturnMessageActive = ref(false)
const packages = ref<FluxPackListItem[]>([])
const plans = ref<FluxPlanListItem[]>([])
const selectedCurrency = ref<string>('usd')
const subscription = ref<FluxSubscriptionStats | null>(null)
const capacity = ref(0)

const isSubscriber = computed(() => subscription.value != null)

const currencyOptions = computed(() => {
  const sources = [
    ...packages.value.map(pkg => pkg.currencies),
    ...plans.value.map(plan => plan.currencies),
  ]
  if (sources.length === 0)
    return []
  const first = Object.keys(sources[0])
  return first
    .filter(c => sources.every(s => c in s))
    .map(c => ({ label: c.toUpperCase(), value: c }))
})

function remainingPercentage(remaining: number, total: number): number {
  if (total <= 0)
    return remaining > 0 ? 100 : 0
  return Math.min(100, Math.round((remaining / total) * 100))
}

const quotaPercentage = computed(() => {
  if (!subscription.value)
    return 0
  return remainingPercentage(subscription.value.periodQuotaRemaining, subscription.value.periodQuotaTotal)
})

const balancePercentage = computed(() => remainingPercentage(credits.value, capacity.value))

const balanceMeterLabel = computed(() => {
  if (subscription.value)
    return t('settings.pages.flux.balanceRow')
  return t(fluxPurchaseDisabled ? 'settings.pages.account.fluxBalance' : 'settings.pages.flux.description')
})

function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num)
}

/**
 * Buckets Flux balances so monetization analytics never expose exact balances.
 */
function fluxBalanceBucket(balance: number | undefined): FluxBalanceBucket {
  if (balance == null || Number.isNaN(balance))
    return 'unknown'
  if (balance <= 0)
    return 'zero'
  if (balance <= 100)
    return '1_100'
  if (balance <= 1000)
    return '101_1000'
  if (balance <= 10000)
    return '1001_10000'
  return '10000_plus'
}

/** Display amount with sign: debit is negative, credit/initial are positive */
function displayAmount(record: AuditRecord): string {
  const signed = record.type === 'debit' ? -record.amount : record.amount
  const formatted = formatNumber(Math.abs(signed))
  return signed >= 0 ? `+${formatted}` : `-${formatted}`
}

function isPositive(record: AuditRecord): boolean {
  return record.type !== 'debit'
}

// Lookup table avoids a chained ternary in the template (banned by CLAUDE.md
// naming/style rules). Unknown types fall back to typeInitial so older
// records without an explicit mapping still render something.
const TYPE_LABEL_KEY: Record<string, string> = {
  debit: 'settings.pages.flux.audit.typeConsumption',
  credit: 'settings.pages.flux.audit.typeAddition',
  initial: 'settings.pages.flux.audit.typeInitial',
  promo: 'settings.pages.flux.audit.typePromo',
}

function typeLabel(type: string): string {
  return t(TYPE_LABEL_KEY[type] ?? TYPE_LABEL_KEY.initial)
}

function billingSourceLabel(source: AuditRecord['billingSource']): string | null {
  if (source === 'balance')
    return t('settings.pages.flux.audit.sourceBalance')
  if (source === 'quota')
    return t('settings.pages.flux.audit.sourceQuota')
  return null
}

const auditRecords = ref<AuditRecord[]>([])
const auditLoading = ref(false)
const auditHasMore = ref(false)
const auditOffset = ref(0)
const AUDIT_PAGE_SIZE = 20

async function fetchStats() {
  try {
    const res = await client.api.v1.flux.stats.$get()
    if (res.ok) {
      // NOTICE:
      // Manual cast: same InferResponseType recursion limit as pack/plan DTOs.
      // Source: packages/server-sdk-shared FluxSubscriptionStats.
      // Removal: when InferResponseType typechecks again.
      const data = await res.json() as {
        capacity: number
        subscription: FluxSubscriptionStats | null
      }
      capacity.value = data.capacity
      subscription.value = data.subscription
    }
  }
  catch {
    // silently fail
  }
}

// On desktop, checkout happens in the external system browser (see handleBuy), so
// the app never receives the success_url redirect that web/mobile use to refresh.
// Re-pull Flux balance and subscription stats whenever the window regains focus;
// the source of truth is the server (credited by the Stripe webhook).
if (isStageTamagotchi()) {
  useEventListener(window, 'focus', () => {
    void authStore.updateCredits()
    void fetchStats()
  })
}

async function fetchAuditHistory(loadMore = false) {
  auditLoading.value = true
  try {
    const offset = loadMore ? auditOffset.value : 0
    const res = await client.api.v1.flux.history.$get({
      query: { limit: String(AUDIT_PAGE_SIZE), offset: String(offset) },
    })
    if (res.ok) {
      const data = await res.json() as { records: AuditRecord[], hasMore: boolean }
      if (loadMore) {
        auditRecords.value.push(...data.records)
      }
      else {
        auditRecords.value = data.records
      }
      auditHasMore.value = data.hasMore
      auditOffset.value = offset + data.records.length
    }
  }
  catch {
    // silently fail
  }
  finally {
    auditLoading.value = false
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString()
}

function formatResetDate(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

// Group consecutive TTS debit records into collapsible rows
type GroupedRow = {
  type: 'single'
  record: AuditRecord
} | {
  type: 'group'
  key: string
  description: string
  model: string
  count: number
  totalAmount: number
  firstTime: string
  lastTime: string
  billingSource?: AuditRecord['billingSource']
  records: AuditRecord[]
}

const expandedGroups = ref<Set<string>>(new Set())

function toggleGroup(key: string) {
  if (expandedGroups.value.has(key))
    expandedGroups.value.delete(key)
  else
    expandedGroups.value.add(key)
}

const groupedRows = computed<GroupedRow[]>(() => {
  const rows: GroupedRow[] = []
  let i = 0
  const records = auditRecords.value

  while (i < records.length) {
    const record = records[i]
    if (record.type === 'debit' && record.description?.startsWith('tts:')) {
      // Collect consecutive TTS records with the same description
      const group: AuditRecord[] = [record]
      while (i + 1 < records.length
        && records[i + 1].type === 'debit'
        && records[i + 1].description === record.description) {
        i++
        group.push(records[i])
      }

      if (group.length > 1) {
        const sources = new Set(group.map(r => r.billingSource).filter(Boolean))
        rows.push({
          type: 'group',
          key: `tts-group-${record.id}`,
          description: record.description,
          model: (record.metadata?.model as string) || '',
          count: group.length,
          totalAmount: group.reduce((sum, r) => sum + r.amount, 0),
          firstTime: group.at(-1)!.createdAt,
          lastTime: group[0].createdAt,
          billingSource: sources.size === 1 ? group[0].billingSource : undefined,
          records: group,
        })
      }
      else {
        rows.push({ type: 'single', record })
      }
    }
    else {
      rows.push({ type: 'single', record })
    }
    i++
  }

  return rows
})

async function fetchPackages() {
  try {
    const res = await client.api.v1.stripe.packages.$get()
    if (res.ok) {
      const data = await res.json() as FluxPackListItem[]
      packages.value = data
      if (data.length > 0 && plans.value.length === 0)
        selectedCurrency.value = data[0].defaultCurrency
    }
  }
  catch {
    if (!checkoutReturnMessageActive.value)
      message.value = { type: 'error', text: t('settings.pages.flux.packagesError') }
  }
}

async function fetchPlans() {
  try {
    const res = await client.api.v1.stripe.plans.$get()
    if (res.ok) {
      const data = await res.json() as FluxPlanListItem[]
      plans.value = data
      if (data.length > 0)
        selectedCurrency.value = data[0].defaultCurrency
    }
  }
  catch {
    if (!checkoutReturnMessageActive.value)
      message.value = { type: 'error', text: t('settings.pages.flux.plans.error') }
  }
}

/**
 * Shows a Stripe return banner that background package refreshes must not replace.
 */
function showCheckoutReturnMessage(type: 'success' | 'error', text: string) {
  checkoutReturnMessageActive.value = true
  message.value = { type, text }
}

function openExternalCheckoutUrl(url: string) {
  // Electron renderer runs from file:// and cannot navigate to Stripe in-window
  // (the settings window would load checkout.stripe.com and never come back).
  // window.open routes through setWindowOpenHandler -> shell.openExternal, so the
  // system browser handles payment. Web keeps the in-window redirect.
  if (isStageTamagotchi())
    window.open(url, '_blank')
  else
    window.location.href = url
}

onMounted(async () => {
  const creditsRefresh = authStore.updateCredits()
  const catalogRefresh = fluxPurchaseDisabled
    ? Promise.resolve()
    : Promise.allSettled([fetchPackages(), fetchPlans()])
  const statsRefresh = Promise.allSettled([fetchStats(), fetchAuditHistory()])

  if (route.query.success === 'true') {
    showCheckoutReturnMessage('success', t('settings.pages.flux.checkout.success'))
    router.replace({ query: {} })
  }
  else if (route.query.canceled === 'true') {
    showCheckoutReturnMessage('error', t('settings.pages.flux.checkout.canceled'))
    router.replace({ query: {} })
  }

  await Promise.all([
    creditsRefresh.catch(() => undefined),
    catalogRefresh,
    statsRefresh,
  ])

  // PostHog funnel step 1: pricing surface view. Today this is an in-app
  // settings page (already-authenticated users); when we add a public
  // pricing landing page the entry-surface label changes but the event stays the
  // same, so the funnel definition in PostHog doesn't need re-wiring.
  if (!fluxPurchaseDisabled) {
    trackPaywallSeen({
      entry_surface: 'settings_flux',
      reason: 'manual_topup',
      flux_balance_bucket: fluxBalanceBucket(credits.value),
    })
    trackPricingViewed('settings_flux', 'one_time')
    if (plans.value.length > 0)
      trackPricingViewed('settings_flux', 'monthly')
    if (credits.value <= 0 && !subscription.value) {
      trackQuotaLimitReached({
        limit_type: 'flux',
        current_usage: credits.value,
        limit_value: capacity.value > 0 ? capacity.value : undefined,
        entry: 'pricing',
      })
    }
    if (subscription.value && subscription.value.periodQuotaRemaining <= 0) {
      trackQuotaLimitReached({
        limit_type: 'subscription',
        current_usage: subscription.value.periodQuotaRemaining,
        limit_value: subscription.value.periodQuotaTotal,
        entry: 'pricing',
      })
    }
  }
})

async function handleBuy(packKey: string) {
  loadingPackKey.value = packKey
  checkoutReturnMessageActive.value = false
  message.value = null
  // PostHog funnel step 2: user picked a plan. price_minor_unit lives on
  // the Stripe webhook (server-side `payment_completed`); we deliberately
  // don't send a formatted-string price from the SPA so funnels don't get
  // poisoned by currency-formatting drift.
  trackUpgradeClicked({
    source_page: 'settings_flux',
    current_plan: 'flux',
    trigger: 'manual_topup',
  })
  trackPlanSelected(packKey, {
    currency: selectedCurrency.value,
    entry_surface: 'settings_flux',
  })
  try {
    const res = await client.api.v1.stripe.checkout.$post({ json: { packKey, currency: selectedCurrency.value } })
    if (!res.ok) {
      const data = await res.json() as { error?: string, message?: string }
      message.value = { type: 'error', text: data.message || t('settings.pages.flux.checkout.error') }
      return
    }
    const data = await res.json()
    if (data.url) {
      // PostHog funnel step 3: about to redirect to Stripe. Capture before
      // the page nav so the event is sent (PostHog's beforeunload handler
      // would otherwise race the navigation).
      trackCheckoutStarted(packKey, {
        currency: selectedCurrency.value,
        entry_surface: 'settings_flux',
      })
      openExternalCheckoutUrl(data.url)
    }
  }
  catch {
    message.value = { type: 'error', text: t('settings.pages.flux.checkout.error') }
  }
  finally {
    loadingPackKey.value = null
  }
}

async function handleSubscribe(planKey: string) {
  if (isSubscriber.value)
    return

  loadingPlanKey.value = planKey
  checkoutReturnMessageActive.value = false
  message.value = null
  trackUpgradeClicked({
    source_page: 'settings_flux',
    current_plan: subscription.value?.planKey ?? 'flux',
    trigger: 'manual_topup',
  })
  trackPlanSelected(planKey, {
    currency: selectedCurrency.value,
    entry_surface: 'settings_flux',
  })
  try {
    const res = await client.api.v1.stripe.checkout.$post({ json: { planKey, currency: selectedCurrency.value } })
    if (!res.ok) {
      const data = await res.json() as { error?: string, message?: string }
      message.value = { type: 'error', text: data.message || t('settings.pages.flux.checkout.error') }
      return
    }
    const data = await res.json() as { url?: string }
    if (data.url) {
      trackCheckoutStarted(planKey, {
        currency: selectedCurrency.value,
        entry_surface: 'settings_flux',
      })
      openExternalCheckoutUrl(data.url)
    }
  }
  catch {
    message.value = { type: 'error', text: t('settings.pages.flux.checkout.error') }
  }
  finally {
    loadingPlanKey.value = null
  }
}

async function handleManagePortal() {
  managingPortal.value = true
  checkoutReturnMessageActive.value = false
  message.value = null
  try {
    const res = await client.api.v1.stripe.portal.$post()
    if (!res.ok) {
      const data = await res.json() as { error?: string, message?: string }
      message.value = { type: 'error', text: data.message || t('settings.pages.flux.checkout.error') }
      return
    }
    const data = await res.json() as { url?: string }
    if (data.url)
      openExternalCheckoutUrl(data.url)
  }
  catch {
    message.value = { type: 'error', text: t('settings.pages.flux.checkout.error') }
  }
  finally {
    managingPortal.value = false
  }
}

async function setUseBalance(enabled: boolean) {
  if (!subscription.value || useBalanceUpdating.value)
    return

  const previous = subscription.value.useBalance
  subscription.value = { ...subscription.value, useBalance: enabled }
  useBalanceUpdating.value = true
  try {
    const res = await client.api.v1.flux['use-balance'].$put({ json: { enabled } })
    if (!res.ok) {
      subscription.value = { ...subscription.value, useBalance: previous }
      const data = await res.json() as { error?: string, message?: string }
      message.value = { type: 'error', text: data.message || t('settings.pages.flux.checkout.error') }
      return
    }
    const data = await res.json() as { useBalance: boolean }
    subscription.value = { ...subscription.value, useBalance: data.useBalance }
  }
  catch {
    subscription.value = { ...subscription.value, useBalance: previous }
    message.value = { type: 'error', text: t('settings.pages.flux.checkout.error') }
  }
  finally {
    useBalanceUpdating.value = false
  }
}

const checkoutBusy = computed(() => loadingPackKey.value !== null || loadingPlanKey.value !== null)
</script>

<template>
  <div
    :class="[
      'flex flex-col gap-6',
      'p-4',
    ]"
  >
    <!-- Message banner -->
    <div
      v-if="message"
      :class="[
        'rounded-lg p-3 text-sm',
        message.type === 'success'
          ? 'bg-green-500/10 text-green-600 dark:text-green-400'
          : 'bg-red-500/10 text-red-600 dark:text-red-400',
      ]"
    >
      {{ message.text }}
    </div>

    <!-- Period + balance -->
    <div
      :class="[
        'flex flex-col gap-6',
        'rounded-2xl p-6 sm:p-8',
        'bg-neutral-100 dark:bg-neutral-800',
      ]"
    >
      <template v-if="subscription">
        <div :class="['flex flex-col gap-3']">
          <div :class="['flex items-center justify-between gap-3']">
            <div :class="['flex min-w-0 items-center gap-3']">
              <div
                :class="[
                  'i-solar:calendar-mark-bold-duotone',
                  'size-10 shrink-0',
                  'text-primary-500',
                ]"
              />
              <p :class="['truncate text-sm text-neutral-500 dark:text-neutral-400']">
                {{ t('settings.pages.flux.quotaDescription') }}
              </p>
            </div>
            <p
              :class="[
                'shrink-0 text-2xl font-bold tracking-tight tabular-nums',
                'text-neutral-800 dark:text-neutral-100',
              ]"
            >
              {{ formatNumber(subscription.periodQuotaRemaining) }}
              <span :class="['text-sm font-normal text-neutral-400']">
                / {{ formatNumber(subscription.periodQuotaTotal) }}
              </span>
            </p>
          </div>
          <div
            :class="[
              'h-2 overflow-hidden rounded-full',
              'bg-neutral-200 dark:bg-neutral-700',
            ]"
            role="progressbar"
            :aria-valuenow="subscription.periodQuotaRemaining"
            :aria-valuemin="0"
            :aria-valuemax="subscription.periodQuotaTotal"
            :aria-label="t('settings.pages.flux.quotaDescription')"
          >
            <div
              :class="[
                'flux-meter-fill',
                'h-full rounded-full',
                'bg-primary-500',
              ]"
              :style="{ '--flux-meter-width': `${quotaPercentage}%` }"
            />
          </div>
          <div :class="['flex items-center justify-between gap-3']">
            <p :class="['text-xs text-neutral-400']">
              {{ t('settings.pages.flux.resetAt', { date: formatResetDate(subscription.resetAt) }) }}
            </p>
            <GhostButton
              v-if="!fluxPurchaseDisabled"
              :label="t('settings.pages.flux.manageSubscription')"
              :loading="managingPortal"
              :disabled="managingPortal || checkoutBusy"
              size="sm"
              @click="handleManagePortal"
            />
          </div>
        </div>
        <div :class="['h-px bg-neutral-200 dark:bg-neutral-700']" />
      </template>

      <div :class="['flex flex-col gap-3']">
        <div :class="['flex items-center justify-between gap-3']">
          <div :class="['flex min-w-0 items-center gap-3']">
            <div
              :class="[
                'i-solar:battery-charge-bold-duotone',
                'size-10 shrink-0',
                'text-primary-500',
              ]"
            />
            <p :class="['truncate text-sm text-neutral-500 dark:text-neutral-400']">
              {{ balanceMeterLabel }}
            </p>
          </div>
          <p
            :class="[
              'shrink-0 text-2xl font-bold tracking-tight tabular-nums',
              'text-neutral-800 dark:text-neutral-100',
            ]"
          >
            {{ formatNumber(credits) }}
          </p>
        </div>
        <div
          :class="[
            'h-2 overflow-hidden rounded-full',
            'bg-neutral-200 dark:bg-neutral-700',
          ]"
          role="progressbar"
          :aria-valuenow="credits"
          :aria-valuemin="0"
          :aria-valuemax="capacity > 0 ? capacity : credits"
          :aria-label="balanceMeterLabel"
        >
          <div
            :class="[
              'flux-meter-fill',
              'h-full rounded-full',
              subscription ? 'bg-primary-500/40' : 'bg-primary-500',
            ]"
            :style="{ '--flux-meter-width': `${balancePercentage}%` }"
          />
        </div>
        <FieldCheckbox
          v-if="subscription && !fluxPurchaseDisabled"
          :model-value="subscription.useBalance"
          :label="t('settings.pages.flux.useBalance')"
          :disabled="useBalanceUpdating"
          @update:model-value="setUseBalance"
        />
      </div>
    </div>

    <div
      v-if="!fluxPurchaseDisabled"
      :class="['flex flex-col gap-6']"
    >
      <!-- Currency selector -->
      <div
        v-if="currencyOptions.length > 1"
        :class="['flex justify-start sm:justify-end']"
      >
        <SelectTab
          v-model="selectedCurrency"
          :options="currencyOptions"
          size="sm"
        />
      </div>

      <!-- Plans -->
      <div
        v-if="plans.length > 0 && !isSubscriber"
        :class="['flex flex-col gap-4']"
      >
        <h3 :class="['text-lg font-semibold']">
          {{ t('settings.pages.flux.plans.title') }}
        </h3>
        <div
          :class="[
            'grid grid-cols-1 gap-4',
            'sm:grid-cols-3',
          ]"
        >
          <button
            v-for="(plan, index) in plans"
            :key="plan.planKey"
            :disabled="checkoutBusy"
            :class="[
              'group relative flex flex-row sm:flex-col items-center justify-between sm:justify-center overflow-hidden text-left sm:text-center gap-4 sm:gap-2',
              'rounded-2xl border-2 bg-white p-6 transition-all duration-300 ease-out',
              plan.recommended ? 'border-primary-400 dark:border-primary-500 shadow-sm' : 'border-neutral-200 dark:border-neutral-800',
              'dark:bg-neutral-900',
              'hover:-translate-y-1 hover:border-primary-400 hover:shadow-md dark:hover:border-primary-500',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              checkoutBusy && loadingPlanKey !== plan.planKey ? 'opacity-50 grayscale-50 cursor-not-allowed' : 'cursor-pointer',
            ]"
            @click="handleSubscribe(plan.planKey)"
          >
            <div
              v-if="plan.recommended"
              :class="[
                'absolute right-0 top-0',
                'flex items-center gap-1',
                'rounded-bl-xl bg-primary-500 px-2.5 py-1',
                'text-[10px] text-white font-bold tracking-wider uppercase shadow-sm',
              ]"
            >
              <div :class="['i-solar:star-fall-bold-duotone size-3']" />
              HOT
            </div>

            <div
              v-if="loadingPlanKey === plan.planKey"
              :class="[
                'absolute inset-0 z-10',
                'flex items-center justify-center',
                'bg-white/60 backdrop-blur-sm dark:bg-neutral-900/60',
              ]"
            >
              <div :class="['i-svg-spinners:90-ring-with-bg size-8 text-primary-500']" />
            </div>

            <div
              :class="[
                'relative z-1 w-full',
                'flex flex-col gap-1 sm:items-center',
              ]"
            >
              <div
                :class="[
                  'text-sm font-medium',
                  'text-neutral-500 dark:text-neutral-400',
                  'transition-colors',
                  'group-hover:text-primary-600 dark:group-hover:text-primary-400',
                ]"
              >
                {{ plan.label }}
              </div>
              <div
                :class="[
                  'flex items-baseline justify-start sm:justify-center gap-1',
                ]"
              >
                <span
                  :class="[
                    'text-2xl font-bold',
                    'text-neutral-800 dark:text-neutral-100',
                  ]"
                >
                  {{ plan.currencies[selectedCurrency] ?? plan.currencies[plan.defaultCurrency] }}
                </span>
              </div>
              <div
                :class="[
                  'text-xs text-neutral-400',
                ]"
              >
                {{ formatNumber(plan.periodQuota) }}
              </div>
              <div
                :class="[
                  'mt-1 text-xs font-medium text-primary-600 dark:text-primary-400',
                ]"
              >
                {{ t('settings.pages.flux.plans.subscribe') }}
              </div>
            </div>

            <div
              :class="[
                'relative z-1 flex items-center gap-1 sm:hidden',
                'text-primary-200 transition-colors dark:text-primary-800/60',
                'group-hover:text-primary-300 dark:group-hover:text-primary-700',
              ]"
            >
              <div
                v-for="i in Math.min(index + 1, 3)"
                :key="i"
                :class="['i-solar:battery-charge-bold-duotone size-8 sm:size-10']"
              />
            </div>
          </button>
        </div>
      </div>

      <!-- Packs -->
      <div
        v-if="packages.length > 0"
        :class="['flex flex-col gap-4']"
      >
        <h3 :class="['text-lg font-semibold']">
          {{ t('settings.pages.flux.packages.title') }}
        </h3>
        <div
          :class="[
            'grid grid-cols-1 gap-4',
            'sm:grid-cols-3',
          ]"
        >
          <button
            v-for="(pkg, index) in packages"
            :key="pkg.packKey"
            :disabled="checkoutBusy"
            :class="[
              'group relative flex flex-row sm:flex-col items-center justify-between sm:justify-center overflow-hidden text-left sm:text-center gap-4 sm:gap-2',
              'rounded-2xl border-2 bg-white p-6 transition-all duration-300 ease-out',
              pkg.recommended ? 'border-primary-400 dark:border-primary-500 shadow-sm' : 'border-neutral-200 dark:border-neutral-800',
              'dark:bg-neutral-900',
              'hover:-translate-y-1 hover:border-primary-400 hover:shadow-md dark:hover:border-primary-500',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500',
              checkoutBusy && loadingPackKey !== pkg.packKey ? 'opacity-50 grayscale-50 cursor-not-allowed' : 'cursor-pointer',
            ]"
            @click="handleBuy(pkg.packKey)"
          >
            <div
              v-if="pkg.recommended"
              :class="[
                'absolute right-0 top-0',
                'flex items-center gap-1',
                'rounded-bl-xl bg-primary-500 px-2.5 py-1',
                'text-[10px] text-white font-bold tracking-wider uppercase shadow-sm',
              ]"
            >
              <div :class="['i-solar:star-fall-bold-duotone size-3']" />
              HOT
            </div>

            <div
              v-if="loadingPackKey === pkg.packKey"
              :class="[
                'absolute inset-0 z-10',
                'flex items-center justify-center',
                'bg-white/60 backdrop-blur-sm dark:bg-neutral-900/60',
              ]"
            >
              <div :class="['i-svg-spinners:90-ring-with-bg size-8 text-primary-500']" />
            </div>

            <div
              :class="[
                'relative z-1 w-full',
                'flex flex-col gap-1 sm:items-center',
              ]"
            >
              <div
                :class="[
                  'text-sm font-medium',
                  'text-neutral-500 dark:text-neutral-400',
                  'transition-colors',
                  'group-hover:text-primary-600 dark:group-hover:text-primary-400',
                ]"
              >
                {{ pkg.label }}
              </div>
              <div
                :class="[
                  'flex items-baseline justify-start sm:justify-center gap-1',
                ]"
              >
                <span
                  :class="[
                    'text-2xl font-bold',
                    'text-neutral-800 dark:text-neutral-100',
                  ]"
                >
                  {{ pkg.currencies[selectedCurrency] ?? pkg.currencies[pkg.defaultCurrency] }}
                </span>
              </div>
            </div>

            <div
              :class="[
                'relative z-1 flex items-center gap-1 sm:hidden',
                'text-primary-200 transition-colors dark:text-primary-800/60',
                'group-hover:text-primary-300 dark:group-hover:text-primary-700',
              ]"
            >
              <div
                v-for="i in Math.min(index + 1, 3)"
                :key="i"
                :class="['i-solar:battery-charge-bold-duotone size-8 sm:size-10']"
              />
            </div>
          </button>
        </div>
      </div>
    </div>

    <!-- Audit History -->
    <div :class="['flex flex-col gap-3']">
      <div
        :class="[
          'flex flex-col gap-1',
          'sm:flex-row sm:items-baseline sm:gap-2',
        ]"
      >
        <h3 :class="['text-lg font-semibold']">
          {{ t('settings.pages.flux.audit.title') }}
        </h3>
        <span :class="['text-xs text-neutral-400']">
          {{ t('settings.pages.flux.audit.delayHint') }}
        </span>
      </div>

      <div
        v-if="auditLoading && auditRecords.length === 0"
        :class="['py-4 text-center text-sm text-neutral-500']"
      >
        {{ t('settings.pages.flux.audit.loading') }}
      </div>

      <div
        v-else-if="auditRecords.length === 0"
        :class="['py-4 text-center text-sm text-neutral-500']"
      >
        {{ t('settings.pages.flux.audit.empty') }}
      </div>

      <!-- Desktop: table -->
      <div
        v-else
        :class="[
          'hidden overflow-x-auto rounded-xl sm:block',
          'border border-neutral-200 dark:border-neutral-800',
        ]"
      >
        <table :class="['w-full text-sm']">
          <thead
            :class="['border-b border-neutral-200 dark:border-neutral-800']"
          >
            <tr>
              <th :class="['px-4 py-3 text-left font-medium']">
                {{ t('settings.pages.flux.audit.time') }}
              </th>
              <th :class="['px-4 py-3 text-left font-medium']">
                {{ t('settings.pages.flux.audit.type') }}
              </th>
              <th :class="['px-4 py-3 text-left font-medium']">
                {{ t('settings.pages.flux.audit.detail') }}
              </th>
              <th :class="['px-4 py-3 text-right font-medium']">
                {{ t('settings.pages.flux.audit.amount') }}
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in groupedRows" :key="row.type === 'single' ? row.record.id : row.key">
              <!-- Single record -->
              <tr
                v-if="row.type === 'single'"
                :class="[
                  'border-b border-neutral-100 last:border-none',
                  'dark:border-neutral-800/50',
                ]"
              >
                <td
                  :class="[
                    'whitespace-nowrap px-4 py-3',
                    'text-neutral-500',
                  ]"
                >
                  {{ formatDate(row.record.createdAt) }}
                </td>
                <td :class="['px-4 py-3']">
                  <div :class="['flex flex-wrap items-center gap-1']">
                    <span
                      :class="[
                        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                        row.record.type === 'debit'
                          ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400'
                          : 'bg-green-500/10 text-green-600 dark:text-green-400',
                      ]"
                    >
                      {{ typeLabel(row.record.type) }}
                    </span>
                    <span
                      v-if="billingSourceLabel(row.record.billingSource)"
                      :class="[
                        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                        'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300',
                      ]"
                    >
                      {{ billingSourceLabel(row.record.billingSource) }}
                    </span>
                  </div>
                </td>
                <td :class="['px-4 py-3']">
                  <span>{{ row.record.description }}</span>
                  <span
                    v-if="row.record.metadata?.promptTokens != null"
                    :class="['ml-1 text-xs text-neutral-400']"
                  >
                    ({{ row.record.metadata.promptTokens }}+{{ row.record.metadata.completionTokens }} tokens)
                  </span>
                  <span
                    v-else-if="row.record.description?.startsWith('tts:') && row.record.metadata?.model"
                    :class="['ml-1 text-xs text-neutral-400']"
                  >
                    ({{ row.record.metadata.model }})
                  </span>
                </td>
                <td :class="['px-4 py-3 text-right font-mono']">
                  <span
                    :class="[
                      isPositive(row.record)
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-orange-600 dark:text-orange-400',
                    ]"
                  >
                    {{ displayAmount(row.record) }}
                  </span>
                </td>
              </tr>

              <!-- Grouped TTS records -->
              <tr
                v-else
                :class="[
                  'cursor-pointer',
                  'border-b border-neutral-100 dark:border-neutral-800/50',
                  'hover:bg-neutral-50 dark:hover:bg-neutral-800/30',
                ]"
                @click="toggleGroup(row.key)"
              >
                <td
                  :class="[
                    'whitespace-nowrap px-4 py-3',
                    'text-neutral-500',
                  ]"
                >
                  {{ formatDate(row.lastTime) }}
                </td>
                <td :class="['px-4 py-3']">
                  <div :class="['flex flex-wrap items-center gap-1']">
                    <span
                      :class="[
                        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                        'bg-orange-500/10 text-orange-600 dark:text-orange-400',
                      ]"
                    >
                      {{ t('settings.pages.flux.audit.typeConsumption') }}
                    </span>
                    <span
                      v-if="billingSourceLabel(row.billingSource)"
                      :class="[
                        'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                        'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300',
                      ]"
                    >
                      {{ billingSourceLabel(row.billingSource) }}
                    </span>
                  </div>
                </td>
                <td :class="['px-4 py-3']">
                  <span :class="['flex items-center gap-1']">
                    <span
                      :class="[
                        'inline-block size-4 text-neutral-400',
                        expandedGroups.has(row.key)
                          ? 'i-solar:alt-arrow-down-line-duotone'
                          : 'i-solar:alt-arrow-right-line-duotone',
                      ]"
                    />
                    {{ row.description }}
                    <span :class="['ml-1 text-xs text-neutral-400']">
                      ({{ row.count }} {{ t('settings.pages.flux.audit.ttsRequests') }})
                    </span>
                  </span>
                </td>
                <td :class="['px-4 py-3 text-right font-mono']">
                  <span :class="['text-orange-600 dark:text-orange-400']">
                    -{{ row.totalAmount }}
                  </span>
                </td>
              </tr>

              <!-- Expanded group children -->
              <tr
                v-for="child in (row.type === 'group' && expandedGroups.has(row.key) ? row.records : [])"
                :key="child.id"
                :class="[
                  'border-b border-neutral-100 last:border-none',
                  'bg-neutral-50/50 dark:border-neutral-800/50 dark:bg-neutral-800/20',
                ]"
              >
                <td
                  :class="[
                    'whitespace-nowrap px-4 py-2 pl-8',
                    'text-xs text-neutral-400',
                  ]"
                >
                  {{ formatDate(child.createdAt) }}
                </td>
                <td :class="['px-4 py-2']">
                  <span
                    v-if="billingSourceLabel(child.billingSource)"
                    :class="[
                      'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                      'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300',
                    ]"
                  >
                    {{ billingSourceLabel(child.billingSource) }}
                  </span>
                </td>
                <td :class="['px-4 py-2 text-xs text-neutral-400']">
                  {{ child.description }}
                </td>
                <td
                  :class="[
                    'px-4 py-2 text-right font-mono',
                    'text-xs text-orange-500 dark:text-orange-400',
                  ]"
                >
                  -{{ child.amount }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <!-- Mobile: card list -->
      <div
        v-if="auditRecords.length > 0"
        :class="['flex flex-col gap-2 sm:hidden']"
      >
        <template v-for="row in groupedRows" :key="row.type === 'single' ? row.record.id : row.key">
          <!-- Single record card -->
          <div
            v-if="row.type === 'single'"
            :class="[
              'flex flex-col gap-1.5 rounded-lg px-3 py-2.5',
              'border border-neutral-200 dark:border-neutral-800',
            ]"
          >
            <div :class="['flex items-center justify-between gap-2']">
              <div :class="['flex flex-wrap items-center gap-1']">
                <span
                  :class="[
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    row.record.type === 'debit'
                      ? 'bg-orange-500/10 text-orange-600 dark:text-orange-400'
                      : 'bg-green-500/10 text-green-600 dark:text-green-400',
                  ]"
                >
                  {{ typeLabel(row.record.type) }}
                </span>
                <span
                  v-if="billingSourceLabel(row.record.billingSource)"
                  :class="[
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300',
                  ]"
                >
                  {{ billingSourceLabel(row.record.billingSource) }}
                </span>
              </div>
              <span
                :class="[
                  'text-sm font-semibold font-mono',
                  isPositive(row.record)
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-orange-600 dark:text-orange-400',
                ]"
              >
                {{ displayAmount(row.record) }}
              </span>
            </div>
            <div
              :class="[
                'truncate text-sm',
                'text-neutral-600 dark:text-neutral-300',
              ]"
            >
              {{ row.record.description }}
              <span
                v-if="row.record.metadata?.promptTokens != null"
                :class="['ml-1 text-xs text-neutral-400']"
              >
                ({{ row.record.metadata.promptTokens }}+{{ row.record.metadata.completionTokens }} tokens)
              </span>
              <span
                v-else-if="row.record.description?.startsWith('tts:') && row.record.metadata?.model"
                :class="['ml-1 text-xs text-neutral-400']"
              >
                ({{ row.record.metadata.model }})
              </span>
            </div>
            <div :class="['text-xs text-neutral-400']">
              {{ formatDate(row.record.createdAt) }}
            </div>
          </div>

          <!-- Grouped TTS card -->
          <div
            v-else
            :class="[
              'flex flex-col gap-1.5 rounded-lg px-3 py-2.5',
              'cursor-pointer',
              'border border-neutral-200 dark:border-neutral-800',
            ]"
            @click="toggleGroup(row.key)"
          >
            <div :class="['flex items-center justify-between gap-2']">
              <div :class="['flex flex-wrap items-center gap-1']">
                <span
                  :class="[
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    'bg-orange-500/10 text-orange-600 dark:text-orange-400',
                  ]"
                >
                  {{ t('settings.pages.flux.audit.typeConsumption') }}
                </span>
                <span
                  v-if="billingSourceLabel(row.billingSource)"
                  :class="[
                    'inline-block rounded-full px-2 py-0.5 text-xs font-medium',
                    'bg-neutral-500/10 text-neutral-600 dark:text-neutral-300',
                  ]"
                >
                  {{ billingSourceLabel(row.billingSource) }}
                </span>
              </div>
              <span
                :class="[
                  'text-sm font-semibold font-mono',
                  'text-orange-600 dark:text-orange-400',
                ]"
              >
                -{{ row.totalAmount }}
              </span>
            </div>
            <div
              :class="[
                'flex items-center gap-1 text-sm',
                'text-neutral-600 dark:text-neutral-300',
              ]"
            >
              <span
                :class="[
                  'inline-block size-4 text-neutral-400',
                  expandedGroups.has(row.key)
                    ? 'i-solar:alt-arrow-down-line-duotone'
                    : 'i-solar:alt-arrow-right-line-duotone',
                ]"
              />
              {{ row.description }}
              <span :class="['text-xs text-neutral-400']">
                ({{ row.count }} {{ t('settings.pages.flux.audit.ttsRequests') }})
              </span>
            </div>
            <div :class="['text-xs text-neutral-400']">
              {{ formatDate(row.lastTime) }}
            </div>

            <div
              v-if="row.type === 'group' && expandedGroups.has(row.key)"
              :class="[
                'mt-1 flex flex-col gap-1 pt-2',
                'border-t border-neutral-200 dark:border-neutral-700',
              ]"
            >
              <div
                v-for="child in row.records"
                :key="child.id"
                :class="[
                  'flex items-center justify-between',
                  'text-xs text-neutral-400',
                ]"
              >
                <span>{{ formatDate(child.createdAt) }}</span>
                <span :class="['font-mono']">-{{ child.amount }}</span>
              </div>
            </div>
          </div>
        </template>
      </div>

      <div
        v-if="auditHasMore"
        :class="['text-center']"
      >
        <Button
          :label="t('settings.pages.flux.audit.loadMore')"
          :loading="auditLoading"
          @click="fetchAuditHistory(true)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.flux-meter-fill {
  width: 0;
  animation: flux-meter-fill-grow 1s cubic-bezier(0.4, 0, 0.2, 1) 0.5s forwards;
}

@keyframes flux-meter-fill-grow {
  to {
    width: var(--flux-meter-width);
  }
}
</style>

<route lang="yaml">
meta:
  layout: settings
  titleKey: settings.pages.flux.title
  icon: i-solar:battery-charge-bold-duotone
</route>
