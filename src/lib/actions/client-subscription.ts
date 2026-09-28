'use server'

import { revalidatePath } from 'next/cache'
import { getSession, isImpersonating } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { fetchClientSubscriptionDetails, normalizeAvailablePlans, normalizeInvoice } from '@/lib/subscription-data'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  changeClientPlanSchema,
  customPricingSchema,
  type AvailablePlan,
  type BillingActionResult,
  type ChangeClientPlanInput,
  type ClientSubscriptionDetails,
  type CustomPricingInput,
  type Invoice,
  type UsageItem,
} from '@/lib/types/subscription'

/**
 * One client's subscription: the business plan the client pays its agency
 * for. The database decides who sees it (the agency's admins, super admins,
 * the client's own admins) and who changes it (the agency's admins, super
 * admins). Prices come from the plans; the agency may only set a custom
 * price for the client.
 */

async function viewerSession(clientId: string) {
  if (!UUID_PATTERN.test(clientId)) return null
  const { supabase, profile } = await getSession()
  if (!profile) return null
  return { supabase, profile }
}

/** Agency admins (and super admins) */
async function managerSession(clientId: string) {
  const session = await viewerSession(clientId)
  if (!session || !isOrgAdmin(session.profile.role)) return null
  return session
}

function revalidateClientBilling() {
  revalidatePath('/[locale]/dashboard', 'layout')
  revalidatePath('/[locale]/admin', 'layout')
}

function fail(error: { code?: string; message: string }, where: string): BillingActionResult {
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error(`[client-subscription] ${where}`, error)
  return { ok: false, error: 'unknown' }
}

/** Plan, effective price (client custom pricing applied), usage. null: no access / no subscription. */
export async function getClientSubscription(clientId: string): Promise<ClientSubscriptionDetails | null> {
  const session = await viewerSession(clientId)
  if (!session) return null
  return fetchClientSubscriptionDetails(session.supabase, clientId)
}

/** Messages, channels, knowledge files and team members against the client's plan. */
export async function getClientUsage(clientId: string): Promise<UsageItem[]> {
  return (await getClientSubscription(clientId))?.usage ?? []
}

/** The agency's invoices to this client, newest first (RLS decides who sees them). */
export async function getClientInvoices(clientId: string): Promise<Invoice[]> {
  const session = await viewerSession(clientId)
  if (!session) return []

  const { data, error } = await session.supabase
    .from('invoices')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .returns<Invoice[]>()
  if (error) throw new Error(`Failed to load client invoices: ${error.message}`)
  return (data ?? []).map(normalizeInvoice)
}

/** Business plans priced for this client (its custom pricing applied). */
export async function getClientAvailablePlans(clientId: string): Promise<AvailablePlan[]> {
  const session = await viewerSession(clientId)
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_client_available_plans', { p_client_id: clientId })
  if (error) throw new Error(`Failed to load plans: ${error.message}`)
  return normalizeAvailablePlans(data as AvailablePlan[] | null)
}

/** Moves the client to another business plan. Limits change right away. */
export async function changeClientPlan(clientId: string, input: ChangeClientPlanInput): Promise<BillingActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const session = await managerSession(clientId)
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = changeClientPlanSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation' }

  const { data, error } = await session.supabase.rpc('change_client_plan', {
    p_client_id: clientId,
    p_plan_id: parsed.data.plan_id,
  })
  if (error) return fail(error, 'changeClientPlan')
  if (data === 'not_found') return { ok: false, error: 'notFound' }
  if (data === 'invalid') return { ok: false, error: 'validation' }
  if (data !== 'ok') return { ok: false, error: 'forbidden' }

  revalidateClientBilling()
  return { ok: true }
}

/**
 * One custom price per client (replaces any previous one). A percentage
 * applies to whichever plan the client is on; a fixed price is tied to the
 * client's current plan.
 */
export async function setClientCustomPricing(clientId: string, input: CustomPricingInput): Promise<BillingActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const session = await managerSession(clientId)
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = customPricingSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: String(parsed.error.issues[0]?.path[0] ?? '') }
  const values = parsed.data

  const { data: subscription } = await session.supabase
    .from('client_subscriptions')
    .select('plan_id')
    .eq('client_id', clientId)
    .maybeSingle<{ plan_id: string }>()
  if (!subscription) return { ok: false, error: 'notFound' }

  const percentage = values.discount_type === 'percentage'
  const { error } = await session.supabase.from('client_custom_pricing').upsert(
    {
      client_id: clientId,
      plan_id: percentage ? null : subscription.plan_id,
      discount_type: values.discount_type,
      discount_percentage: percentage ? values.discount_percentage : null,
      fixed_price_monthly: percentage ? null : values.fixed_price_monthly,
      reason: values.reason || null,
      valid_until: values.valid_until,
      created_by: session.profile.id,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'client_id' }
  )
  if (error) return fail(error, 'setClientCustomPricing')

  revalidateClientBilling()
  return { ok: true }
}

export async function removeClientCustomPricing(clientId: string): Promise<BillingActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const session = await managerSession(clientId)
  if (!session) return { ok: false, error: 'forbidden' }

  const { error } = await session.supabase.from('client_custom_pricing').delete().eq('client_id', clientId)
  if (error) return fail(error, 'removeClientCustomPricing')

  revalidateClientBilling()
  return { ok: true }
}
