'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isSuperAdmin } from '@/lib/auth/permissions'
import {
  fetchClientSubscriptionDetails,
  fetchSubscriptionDetails,
  nextPeriod,
  normalizeInvoice,
  normalizeUsage,
  num,
} from '@/lib/subscription-data'
import { UUID_PATTERN } from '@/lib/types/clients'
import type { OrgType } from '@/lib/types/admin'
import {
  BILLED_TO,
  changePlanSchema,
  CLIENT_LIMIT_TYPES,
  customPricingSchema,
  INVOICE_STATUSES,
  invoiceSchema,
  markPaidSchema,
  ORG_LIMIT_TYPES,
  PLAN_TYPES,
  SUBSCRIPTION_STATUSES,
  type BilledTo,
  type BillingActionResult,
  type ChangePlanInput,
  type ClientSubscriptionRow,
  type CustomPricingInput,
  type Invoice,
  type InvoiceInput,
  type InvoiceStatus,
  type MarkPaidInput,
  type PlanType,
  type SubscriptionDetails,
  type SubscriptionRow,
  type SubscriptionStatus,
  type UsageItem,
} from '@/lib/types/subscription'

export type { BillingActionError, BillingActionResult } from '@/lib/types/subscription'

const DAY = 24 * 60 * 60 * 1000
const MAX_EXTEND_DAYS = 366

async function superAdminSession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isSuperAdmin(profile.role)) return null
  return { supabase, profile }
}

function revalidateBilling() {
  revalidatePath('/[locale]/admin', 'layout')
  revalidatePath('/[locale]/dashboard', 'layout')
}

function fail(error: { code?: string; message: string }, where: string): BillingActionResult {
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error(`[admin-subscriptions] ${where}`, error)
  return { ok: false, error: 'unknown' }
}

function firstField(error: { issues: { path: PropertyKey[] }[] }) {
  return String(error.issues[0]?.path[0] ?? '')
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

type SubscriptionRowRaw = Omit<SubscriptionRow, 'usage'> & { usage: UsageItem[] | null }

/** Every subscription, optionally filtered by plan type and status. */
export async function getAllSubscriptions(filters: {
  planType?: PlanType
  status?: SubscriptionStatus
} = {}): Promise<SubscriptionRow[]> {
  const session = await superAdminSession()
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_all_subscriptions')
  if (error) throw new Error(`Failed to load subscriptions: ${error.message}`)

  const planType = (PLAN_TYPES as readonly string[]).includes(filters.planType ?? '') ? filters.planType : undefined
  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(filters.status ?? '') ? filters.status : undefined

  return ((data as SubscriptionRowRaw[] | null) ?? [])
    .filter((row) => (!planType || row.plan_type === planType) && (!status || row.status === status))
    .map((row) => ({
      ...row,
      base_price: num(row.base_price),
      effective_price: num(row.effective_price),
      usage: normalizeUsage(row.usage, ORG_LIMIT_TYPES),
    }))
}

type ClientSubscriptionRowRaw = Omit<ClientSubscriptionRow, 'usage'> & { usage: UsageItem[] | null }

/** Every client subscription in every organization, optionally filtered by status / organization. */
export async function getAllClientSubscriptions(filters: {
  status?: SubscriptionStatus
  organizationId?: string
} = {}): Promise<ClientSubscriptionRow[]> {
  const session = await superAdminSession()
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_all_client_subscriptions')
  if (error) throw new Error(`Failed to load client subscriptions: ${error.message}`)

  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(filters.status ?? '') ? filters.status : undefined
  const organizationId = UUID_PATTERN.test(filters.organizationId ?? '') ? filters.organizationId : undefined

  return ((data as ClientSubscriptionRowRaw[] | null) ?? [])
    .filter((row) => (!status || row.status === status) && (!organizationId || row.organization_id === organizationId))
    .map((row) => ({
      ...row,
      base_price: num(row.base_price),
      effective_price: num(row.effective_price),
      usage: normalizeUsage(row.usage, CLIENT_LIMIT_TYPES),
    }))
}

/** The organization's own subscription and the platform's invoices to it (org details page). */
export async function getOrganizationBilling(
  organizationId: string
): Promise<{ details: SubscriptionDetails | null; invoices: Invoice[] } | null> {
  if (!UUID_PATTERN.test(organizationId)) return null
  const session = await superAdminSession()
  if (!session) return null

  const [details, invoices] = await Promise.all([
    fetchSubscriptionDetails(session.supabase, organizationId),
    session.supabase
      .from('invoices')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('billed_to', 'platform')
      .order('created_at', { ascending: false })
      .returns<Invoice[]>(),
  ])
  if (invoices.error) throw new Error(`Failed to load invoices: ${invoices.error.message}`)
  return { details, invoices: (invoices.data ?? []).map(normalizeInvoice) }
}

export async function changePlan(organizationId: string, input: ChangePlanInput): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(organizationId)) return { ok: false, error: 'notFound' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = changePlanSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: firstField(parsed.error) }

  const { data, error } = await session.supabase
    .from('subscriptions')
    .update(parsed.data)
    .eq('organization_id', organizationId)
    .select('id')
  if (error) return fail(error, 'changePlan')
  if (!data?.length) return { ok: false, error: 'notFound' }

  revalidateBilling()
  return { ok: true }
}

/**
 * One custom price per organization (replaces any previous one).
 * A percentage applies to whichever plan the org is on; a fixed price is
 * tied to the org's current plan.
 */
export async function setCustomPricing(
  organizationId: string,
  input: CustomPricingInput
): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(organizationId)) return { ok: false, error: 'notFound' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = customPricingSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: firstField(parsed.error) }
  const values = parsed.data

  const { data: subscription } = await session.supabase
    .from('subscriptions')
    .select('plan_id')
    .eq('organization_id', organizationId)
    .maybeSingle<{ plan_id: string }>()
  if (!subscription) return { ok: false, error: 'notFound' }

  const percentage = values.discount_type === 'percentage'
  const { error } = await session.supabase.from('custom_pricing').upsert(
    {
      organization_id: organizationId,
      plan_id: percentage ? null : subscription.plan_id,
      discount_type: values.discount_type,
      discount_percentage: percentage ? values.discount_percentage : null,
      fixed_price_monthly: percentage ? null : values.fixed_price_monthly,
      reason: values.reason || null,
      valid_until: values.valid_until,
      created_by: session.profile.id,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id' }
  )
  if (error) return fail(error, 'setCustomPricing')

  revalidateBilling()
  return { ok: true }
}

export async function removeCustomPricing(organizationId: string): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(organizationId)) return { ok: false, error: 'notFound' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const { error } = await session.supabase.from('custom_pricing').delete().eq('organization_id', organizationId)
  if (error) return fail(error, 'removeCustomPricing')

  revalidateBilling()
  return { ok: true }
}

/**
 * Adds days to the current period (and the trial, while trialing). A period
 * that already ended is extended from today.
 */
export async function extendPeriod(organizationId: string, days: number): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(organizationId)) return { ok: false, error: 'notFound' }
  if (!Number.isInteger(days) || days < 1 || days > MAX_EXTEND_DAYS) return { ok: false, error: 'validation', field: 'days' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const { data: sub } = await session.supabase
    .from('subscriptions')
    .select('status, current_period_end, trial_ends_at')
    .eq('organization_id', organizationId)
    .maybeSingle<{ status: SubscriptionStatus; current_period_end: string; trial_ends_at: string | null }>()
  if (!sub) return { ok: false, error: 'notFound' }

  const extend = (from: string | null) =>
    new Date(Math.max(from ? Date.parse(from) : 0, Date.now()) + days * DAY).toISOString()

  const { error } = await session.supabase
    .from('subscriptions')
    .update({
      current_period_end: extend(sub.current_period_end),
      ...(sub.status === 'trialing' ? { trial_ends_at: extend(sub.trial_ends_at) } : {}),
    })
    .eq('organization_id', organizationId)
  if (error) return fail(error, 'extendPeriod')

  revalidateBilling()
  return { ok: true }
}

/** Recounts the organization's clients and team members and clears its usage alerts. */
export async function resetUsage(organizationId: string): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(organizationId)) return { ok: false, error: 'notFound' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const { data, error } = await session.supabase.rpc('reset_subscription_usage', { p_org_id: organizationId })
  if (error) return fail(error, 'resetUsage')
  if (!data) return { ok: false, error: 'notFound' }

  revalidateBilling()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

/**
 * Every invoice with its organization's (and client's) name, filtered by
 * status / organization / who issued it (platform → agencies, or agencies →
 * their clients).
 */
export async function getAllInvoices(filters: {
  status?: InvoiceStatus
  organizationId?: string
  billedTo?: BilledTo
} = {}): Promise<Invoice[]> {
  const session = await superAdminSession()
  if (!session) return []

  let query = session.supabase
    .from('invoices')
    .select('*, organization:organizations(name), client:clients(name)')
    .order('created_at', { ascending: false })
    .limit(500)
  if ((INVOICE_STATUSES as readonly string[]).includes(filters.status ?? '')) query = query.eq('status', filters.status!)
  if (filters.organizationId && UUID_PATTERN.test(filters.organizationId)) {
    query = query.eq('organization_id', filters.organizationId)
  }
  if ((BILLED_TO as readonly string[]).includes(filters.billedTo ?? '')) query = query.eq('billed_to', filters.billedTo!)

  const { data, error } = await query.returns<
    (Invoice & { organization: { name: string } | null; client: { name: string } | null })[]
  >()
  if (error) throw new Error(`Failed to load invoices: ${error.message}`)
  return (data ?? []).map(({ organization, client, ...row }) => ({
    ...normalizeInvoice(row),
    organization_name: organization?.name ?? '',
    client_name: client?.name ?? undefined,
  }))
}

/** Organizations to pick from when creating an invoice (agencies and direct businesses). */
export async function getInvoiceOrganizations(): Promise<{ id: string; name: string; org_type: OrgType }[]> {
  const session = await superAdminSession()
  if (!session) return []
  const { data, error } = await session.supabase
    .from('organizations')
    .select('id, name, org_type')
    .order('name')
    .returns<{ id: string; name: string; org_type: OrgType }[]>()
  if (error) throw new Error(`Failed to load organizations: ${error.message}`)
  return data ?? []
}

/**
 * What the platform bills an organization for: an agency's own
 * subscription, or a direct business's one client's subscription.
 */
async function billedSubscription(supabase: SuperAdminSupabase, organizationId: string) {
  const { data: org } = await supabase
    .from('organizations')
    .select('org_type')
    .eq('id', organizationId)
    .maybeSingle<{ org_type: OrgType }>()
  if (!org) return null

  if (org.org_type === 'direct') {
    const { data: client } = await supabase
      .from('clients')
      .select('id')
      .eq('organization_id', organizationId)
      .limit(1)
      .maybeSingle<{ id: string }>()
    const details = client ? await fetchClientSubscriptionDetails(supabase, client.id) : null
    return details && { details, clientId: client!.id, subscriptionId: null }
  }

  const details = await fetchSubscriptionDetails(supabase, organizationId)
  return details && { details, clientId: null, subscriptionId: details.subscription.id }
}

type SuperAdminSupabase = NonNullable<Awaited<ReturnType<typeof superAdminSession>>>['supabase']

/** Prefill for a new invoice: the monthly effective price and the month after the current period. */
export async function getInvoiceDefaults(organizationId: string): Promise<{
  amount: number
  periodStart: string
  periodEnd: string
} | null> {
  if (!UUID_PATTERN.test(organizationId)) return null
  const session = await superAdminSession()
  if (!session) return null

  const billed = await billedSubscription(session.supabase, organizationId)
  if (!billed) return null

  return { amount: billed.details.price.current, ...nextPeriod(billed.details.subscription.current_period_end) }
}

export async function createInvoice(input: InvoiceInput): Promise<BillingActionResult> {
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = invoiceSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: firstField(parsed.error) }
  const values = parsed.data
  if (Date.parse(values.period_end) <= Date.parse(values.period_start)) {
    return { ok: false, error: 'validation', field: 'period_end' }
  }

  const billed = await billedSubscription(session.supabase, values.organization_id)
  if (!billed) return { ok: false, error: 'notFound' }

  // invoice_number is assigned by the database (INV-<year>-0001, one
  // sequence for every kind of invoice). A direct business's invoice
  // carries its client, whose subscription it pays for.
  const { error } = await session.supabase.from('invoices').insert({
    organization_id: values.organization_id,
    client_id: billed.clientId,
    billed_to: 'platform',
    subscription_id: billed.subscriptionId,
    amount: values.amount,
    period_start: values.period_start,
    period_end: values.period_end,
    status: values.status,
    notes: values.notes || null,
  })
  if (error) return fail(error, 'createInvoice')

  revalidateBilling()
  return { ok: true }
}

/** Records the payment; the subscription becomes active and moves on to the invoice's period. */
export async function markInvoicePaid(invoiceId: string, input: MarkPaidInput): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(invoiceId)) return { ok: false, error: 'notFound' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = markPaidSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: firstField(parsed.error) }

  const { data, error } = await session.supabase.rpc('mark_invoice_paid', {
    p_invoice_id: invoiceId,
    p_payment_method: parsed.data.payment_method,
    p_payment_reference: parsed.data.payment_reference ?? '',
    p_paid_at: parsed.data.paid_at,
  })
  if (error) return fail(error, 'markInvoicePaid')
  if (data === 'not_found') return { ok: false, error: 'notFound' }
  if (data === 'invalid_status') return { ok: false, error: 'invalidStatus' }
  if (data !== 'ok') return { ok: false, error: 'forbidden' }

  revalidateBilling()
  return { ok: true }
}

/** Draft → sent, sent → overdue, or cancel. Paid invoices are final. */
export async function setInvoiceStatus(
  invoiceId: string,
  status: Exclude<InvoiceStatus, 'paid'>
): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(invoiceId)) return { ok: false, error: 'notFound' }
  if (!(['draft', 'sent', 'overdue', 'cancelled'] as string[]).includes(status)) return { ok: false, error: 'validation' }
  const session = await superAdminSession()
  if (!session) return { ok: false, error: 'forbidden' }

  const { data, error } = await session.supabase
    .from('invoices')
    .update({ status })
    .eq('id', invoiceId)
    .neq('status', 'paid')
    .select('id')
  if (error) return fail(error, 'setInvoiceStatus')
  if (!data?.length) return { ok: false, error: 'invalidStatus' }

  revalidateBilling()
  return { ok: true }
}
