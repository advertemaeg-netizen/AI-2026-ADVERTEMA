import 'server-only'
import type { getSession } from '@/lib/auth/session'
import { LIMIT_TYPES, type Invoice, type Plan, type SubscriptionDetails, type UsageItem } from '@/lib/types/subscription'

// Postgres numeric/bigint can arrive as strings
export const num = (value: unknown) => Number(value ?? 0)
export const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value))

type Supabase = Awaited<ReturnType<typeof getSession>>['supabase']

/** Normalizes get_subscription_details() output (numbers, usage order). */
function normalizeDetails(raw: SubscriptionDetails): SubscriptionDetails {
  const usage = LIMIT_TYPES.map((type): UsageItem => {
    const item = raw.usage?.find((u) => u.limit_type === type)
    return {
      limit_type: type,
      used: num(item?.used),
      limit: numOrNull(item?.limit),
      percentage: numOrNull(item?.percentage),
    }
  })
  return {
    ...raw,
    plan: { ...raw.plan, price_monthly: num(raw.plan.price_monthly), price_yearly: num(raw.plan.price_yearly) },
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
    usage,
  }
}

/** get_subscription_details(); the admin panel passes any organization. */
export async function fetchSubscriptionDetails(
  supabase: Supabase,
  organizationId: string
): Promise<SubscriptionDetails | null> {
  const { data, error } = await supabase.rpc('get_subscription_details', { p_org_id: organizationId })
  if (error) throw new Error(`Failed to load subscription: ${error.message}`)
  return data ? normalizeDetails(data as SubscriptionDetails) : null
}

export function normalizeInvoice(row: Invoice): Invoice {
  return { ...row, amount: num(row.amount) }
}

export function normalizePlan<T extends Plan>(plan: T): T {
  return {
    ...plan,
    price_monthly: num(plan.price_monthly),
    price_yearly: num(plan.price_yearly),
    features: Array.isArray(plan.features) ? plan.features : [],
  }
}
