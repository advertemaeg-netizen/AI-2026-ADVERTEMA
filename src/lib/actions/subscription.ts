'use server'

import { revalidatePath } from 'next/cache'
import { getSession, isImpersonating } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { fetchSubscriptionDetails, normalizeAvailablePlans, normalizeInvoice, num } from '@/lib/subscription-data'
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

/**
 * The caller's organization's own subscription (the agency plan paid to the
 * platform): plan, effective price, custom pricing, clients / team usage.
 * Clients' subscriptions are in client-subscription.ts and agency-billing.ts.
 */
export async function getSubscription(): Promise<SubscriptionDetails | null> {
  const session = await billingSession()
  if (!session) return null
  return fetchSubscriptionDetails(session.supabase, session.organizationId)
}

/** Organization-level usage (clients, team members). */
export async function getUsage(): Promise<UsageItem[]> {
  return (await getSubscription())?.usage ?? []
}

/** The platform's invoices to the caller's organization, newest first (RLS: org admins). */
export async function getInvoices(): Promise<Invoice[]> {
  const session = await billingSession()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('invoices')
    .select('*')
    .eq('organization_id', session.organizationId)
    .eq('billed_to', 'platform')
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
  return normalizeAvailablePlans(data as AvailablePlan[] | null)
}

/** Limits at 80 / 90 / 100 % that the org admin hasn't dismissed yet: the organization's and its clients'. */
export async function getUsageAlerts(): Promise<UsageAlert[]> {
  const session = await billingSession()
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_active_usage_alerts')
  if (error) {
    console.error('[subscription] usage alerts', error)
    return []
  }
  type Row = Omit<UsageAlert, 'limit'> & { limit_value: number }
  return ((data as Row[] | null) ?? [])
    .map((row) => ({
      limit_type: row.limit_type,
      threshold: num(row.threshold),
      used: num(row.used),
      limit: num(row.limit_value),
      client_id: row.client_id ?? null,
      client_name: row.client_name ?? null,
    }))
    .sort((a, b) => b.threshold - a.threshold)
}

export async function dismissUsageAlerts(): Promise<{ ok: boolean }> {
  if (await isImpersonating()) return { ok: false }
  const session = await billingSession()
  if (!session) return { ok: false }
  const { error } = await session.supabase.rpc('dismiss_usage_alerts')
  if (error) return { ok: false }
  revalidatePath('/[locale]/dashboard', 'layout')
  return { ok: true }
}
