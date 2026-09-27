import 'server-only'
import type { getSession } from '@/lib/auth/session'
import {
  CLIENT_LIMIT_TYPES,
  ORG_LIMIT_TYPES,
  type AvailablePlan,
  type BillingCycle,
  type ClientSubscriptionDetails,
  type Invoice,
  type LimitType,
  type Plan,
  type SubscriptionDetails,
  type UsageItem,
} from '@/lib/types/subscription'

// Postgres numeric/bigint can arrive as strings
export const num = (value: unknown) => Number(value ?? 0)
export const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value))

type Supabase = Awaited<ReturnType<typeof getSession>>['supabase']

/** One item per limit type, in order (numbers from Postgres, missing ones at 0). */
export function normalizeUsage(raw: UsageItem[] | null | undefined, types: readonly LimitType[]): UsageItem[] {
  return types.map((type): UsageItem => {
    const item = raw?.find((u) => u.limit_type === type)
    const used = num(item?.used)
    const limit = numOrNull(item?.limit)
    return {
      limit_type: type,
      used,
      limit,
      percentage:
        item?.percentage !== undefined && item.percentage !== null
          ? Number(item.percentage)
          : limit === null
            ? null
            : limit === 0
              ? 100
              : Math.round((used * 1000) / limit) / 10,
    }
  })
}

/** Normalizes get_(client_)subscription_details() output (numbers, usage order). */
function normalizeDetails<T extends SubscriptionDetails | ClientSubscriptionDetails>(raw: T, types: readonly LimitType[]): T {
  return {
    ...raw,
    plan: normalizePlan(raw.plan),
    custom_pricing: raw.custom_pricing && {
      ...raw.custom_pricing,
      discount_percentage: numOrNull(raw.custom_pricing.discount_percentage),
      fixed_price_monthly: numOrNull(raw.custom_pricing.fixed_price_monthly),
      fixed_price_yearly: numOrNull(raw.custom_pricing.fixed_price_yearly),
    },
    price: {
      monthly: num(raw.price.monthly),
      yearly: num(raw.price.yearly),
      current: num(raw.price.current),
      base_current: num(raw.price.base_current),
    },
    usage: normalizeUsage(raw.usage, types),
  }
}

/** get_subscription_details(); the admin panel passes any organization. */
export async function fetchSubscriptionDetails(
  supabase: Supabase,
  organizationId: string
): Promise<SubscriptionDetails | null> {
  const { data, error } = await supabase.rpc('get_subscription_details', { p_org_id: organizationId })
  if (error) throw new Error(`Failed to load subscription: ${error.message}`)
  return data ? normalizeDetails(data as SubscriptionDetails, ORG_LIMIT_TYPES) : null
}

/** get_client_subscription_details(); null when the caller may not see the client's billing. */
export async function fetchClientSubscriptionDetails(
  supabase: Supabase,
  clientId: string
): Promise<ClientSubscriptionDetails | null> {
  const { data, error } = await supabase.rpc('get_client_subscription_details', { p_client_id: clientId })
  if (error) throw new Error(`Failed to load client subscription: ${error.message}`)
  return data ? normalizeDetails(data as ClientSubscriptionDetails, CLIENT_LIMIT_TYPES) : null
}

/** Plans with a customer's effective prices (get_available_plans / get_client_available_plans). */
export function normalizeAvailablePlans(rows: AvailablePlan[] | null): AvailablePlan[] {
  return (rows ?? []).map((plan) => ({
    ...normalizePlan(plan),
    effective_monthly: num(plan.effective_monthly),
    effective_yearly: num(plan.effective_yearly),
  }))
}

/** The next billing period after `from` (invoice prefill). */
export function nextPeriod(from: string, cycle: BillingCycle) {
  const start = new Date(from)
  const end = new Date(start)
  if (cycle === 'yearly') end.setUTCFullYear(end.getUTCFullYear() + 1)
  else end.setUTCMonth(end.getUTCMonth() + 1)
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() }
}

export function normalizeInvoice(row: Invoice): Invoice {
  return { ...row, amount: num(row.amount), billed_to: row.billed_to ?? (row.client_id ? 'agency' : 'platform') }
}

export function normalizePlan<T extends Plan>(plan: T): T {
  return {
    ...plan,
    price_monthly: num(plan.price_monthly),
    price_yearly: num(plan.price_yearly),
    features: Array.isArray(plan.features) ? plan.features : [],
  }
}
