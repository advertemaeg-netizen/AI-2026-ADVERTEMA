import 'server-only'
import type { getSession } from '@/lib/auth/session'
import {
  CLIENT_LIMIT_TYPES,
  ORG_LIMIT_TYPES,
  type AvailablePlan,
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
    },
    price: { current: num(raw.price.current), base: num(raw.price.base) },
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
  if (!data) return null

  const details = normalizeDetails(data as ClientSubscriptionDetails, CLIENT_LIMIT_TYPES)
  // Messages analysed for leads past the limit have their own counter
  const { data: counters } = await supabase
    .from('client_subscriptions')
    .select('lead_capture_used')
    .eq('client_id', clientId)
    .maybeSingle<{ lead_capture_used: number }>()
  return {
    ...details,
    usage: details.usage.map((item) =>
      item.limit_type === 'messages' && counters ? { ...item, lead_capture_used: num(counters.lead_capture_used) } : item
    ),
  }
}

/** Plans with a customer's effective prices (get_available_plans / get_client_available_plans). */
export function normalizeAvailablePlans(rows: AvailablePlan[] | null): AvailablePlan[] {
  return (rows ?? []).map((plan) => ({
    ...normalizePlan(plan),
    effective_monthly: num(plan.effective_monthly),
  }))
}

/** The month after `from` (invoice prefill). */
export function nextPeriod(from: string) {
  const start = new Date(from)
  const end = new Date(start)
  end.setUTCMonth(end.getUTCMonth() + 1)
  return { periodStart: start.toISOString(), periodEnd: end.toISOString() }
}

export function normalizeInvoice(row: Invoice): Invoice {
  return { ...row, amount: num(row.amount), billed_to: row.billed_to ?? (row.client_id ? 'agency' : 'platform') }
}

export function normalizePlan<T extends Plan>(plan: T): T {
  return {
    ...plan,
    price_monthly: num(plan.price_monthly),
    max_file_size_mb: numOrNull(plan.max_file_size_mb),
    features: Array.isArray(plan.features) ? plan.features : [],
  }
}
