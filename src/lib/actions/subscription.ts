'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { fetchSubscriptionDetails, normalizeInvoice, num } from '@/lib/subscription-data'
import {
  PLAN_TYPES,
  type AvailablePlan,
  type Invoice,
  type PlanType,
  type SubscriptionDetails,
  type UsageAlert,
  type UsageItem,
} from '@/lib/types/subscription'

/** Org admins (and super admins, for their own organization) see billing. */
async function billingSession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isOrgAdmin(profile.role) || !profile.organization_id) return null
  return { supabase, organizationId: profile.organization_id }
}

/** The caller's organization's subscription: plan, effective price, custom pricing, usage. */
export async function getSubscription(): Promise<SubscriptionDetails | null> {
  const session = await billingSession()
  if (!session) return null
  return fetchSubscriptionDetails(session.supabase, session.organizationId)
}

/** Usage per limit for the caller's organization. */
export async function getUsage(): Promise<UsageItem[]> {
  return (await getSubscription())?.usage ?? []
}

/** The caller's organization's invoices, newest first (RLS: org admins). */
export async function getInvoices(): Promise<Invoice[]> {
  const session = await billingSession()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('invoices')
    .select('*')
    .eq('organization_id', session.organizationId)
    .order('created_at', { ascending: false })
    .returns<Invoice[]>()
  if (error) throw new Error(`Failed to load invoices: ${error.message}`)
  return (data ?? []).map(normalizeInvoice)
}

/** Plans of one type, priced for the caller's organization (custom pricing applied). */
export async function getAvailablePlans(planType: PlanType): Promise<AvailablePlan[]> {
  if (!(PLAN_TYPES as readonly string[]).includes(planType)) return []
  const session = await billingSession()
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_available_plans', { p_plan_type: planType })
  if (error) throw new Error(`Failed to load plans: ${error.message}`)
  return ((data as AvailablePlan[] | null) ?? []).map((plan) => ({
    ...plan,
    price_monthly: num(plan.price_monthly),
    price_yearly: num(plan.price_yearly),
    effective_monthly: num(plan.effective_monthly),
    effective_yearly: num(plan.effective_yearly),
  }))
}

/** Limits at 80 / 90 / 100 % that the org admin hasn't dismissed yet. */
export async function getUsageAlerts(): Promise<UsageAlert[]> {
  const session = await billingSession()
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_active_usage_alerts')
  if (error) {
    console.error('[subscription] usage alerts', error)
    return []
  }
  return ((data as { limit_type: UsageAlert['limit_type']; threshold: number; used: number; limit_value: number }[] | null) ?? [])
    .map((row) => ({ limit_type: row.limit_type, threshold: num(row.threshold), used: num(row.used), limit: num(row.limit_value) }))
    .sort((a, b) => b.threshold - a.threshold)
}

export async function dismissUsageAlerts(): Promise<{ ok: boolean }> {
  const session = await billingSession()
  if (!session) return { ok: false }
  const { error } = await session.supabase.rpc('dismiss_usage_alerts')
  if (error) return { ok: false }
  revalidatePath('/[locale]/dashboard', 'layout')
  return { ok: true }
}
