'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { fetchClientSubscriptionDetails, nextPeriod, normalizeInvoice, normalizeUsage, num } from '@/lib/subscription-data'
import { cairoParts, cairoWallTimeToIso } from '@/lib/cairo-time'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  CLIENT_LIMIT_TYPES,
  clientInvoiceSchema,
  markPaidSchema,
  type BillingActionResult,
  type BillingCycle,
  type ClientBillingRow,
  type ClientInvoiceInput,
  type Invoice,
  type InvoiceStatus,
  type MarkPaidInput,
  type UsageItem,
} from '@/lib/types/subscription'

/**
 * The agency billing its own clients: each client's plan and effective
 * price, invoices from the agency to the client, payments. Money here goes
 * from the client to the agency, never to the platform.
 */

async function agencySession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isOrgAdmin(profile.role) || !profile.organization_id) return null
  return { supabase, profile, organizationId: profile.organization_id }
}

function revalidateAgencyBilling() {
  revalidatePath('/[locale]/dashboard', 'layout')
  revalidatePath('/[locale]/admin', 'layout')
}

function fail(error: { code?: string; message: string }, where: string): BillingActionResult {
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error(`[agency-billing] ${where}`, error)
  return { ok: false, error: 'unknown' }
}

type ClientBillingRowRaw = Omit<ClientBillingRow, 'usage'> & { usage: UsageItem[] | null }

/** Every client of the caller's agency: plan, effective price, usage, renewal, open invoices. */
export async function getAgencyClientsBilling(): Promise<ClientBillingRow[]> {
  const session = await agencySession()
  if (!session) return []

  const { data, error } = await session.supabase.rpc('get_agency_clients_billing')
  if (error) throw new Error(`Failed to load clients billing: ${error.message}`)
  return ((data as ClientBillingRowRaw[] | null) ?? []).map((row) => ({
    ...row,
    base_price: num(row.base_price),
    effective_price: num(row.effective_price),
    monthly_value: num(row.monthly_value),
    open_invoices: num(row.open_invoices),
    open_amount: num(row.open_amount),
    usage: normalizeUsage(row.usage, CLIENT_LIMIT_TYPES),
  }))
}

export type MonthlyRevenue = {
  /** Paying clients (active, payment due): effective price per month */
  expected: number
  /** Clients on a free trial, if they all convert */
  trialPipeline: number
  /** Sent / overdue invoices not paid yet */
  outstanding: number
  /** Invoices paid since the 1st of this month (Cairo) */
  collectedThisMonth: number
  payingClients: number
  trialingClients: number
}

/** Expected monthly revenue from the agency's clients, plus what's owed and collected. */
export async function getMonthlyRevenue(rows?: ClientBillingRow[]): Promise<MonthlyRevenue | null> {
  const session = await agencySession()
  if (!session) return null

  const clients = rows ?? (await getAgencyClientsBilling())
  const paying = clients.filter((c) => c.status === 'active' || c.status === 'past_due')
  const trialing = clients.filter((c) => c.status === 'trialing' && c.usable)

  const now = cairoParts(new Date())
  const monthStart = cairoWallTimeToIso(now.year, now.month, 1, '00:00')
  const { data, error } = await session.supabase
    .from('invoices')
    .select('amount')
    .eq('organization_id', session.organizationId)
    .eq('billed_to', 'agency')
    .eq('status', 'paid')
    .gte('paid_at', monthStart)
    .returns<{ amount: number }[]>()
  if (error) throw new Error(`Failed to load payments: ${error.message}`)

  const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100
  return {
    expected: sum(paying.map((c) => c.monthly_value)),
    trialPipeline: sum(trialing.map((c) => c.monthly_value)),
    outstanding: sum(clients.map((c) => c.open_amount)),
    collectedThisMonth: sum((data ?? []).map((row) => num(row.amount))),
    payingClients: paying.length,
    trialingClients: trialing.length,
  }
}

/** The agency's invoices to its clients (with the client's name), newest first. */
export async function getAgencyClientInvoices(): Promise<Invoice[]> {
  const session = await agencySession()
  if (!session) return []

  const { data, error } = await session.supabase
    .from('invoices')
    .select('*, client:clients(name)')
    .eq('organization_id', session.organizationId)
    .eq('billed_to', 'agency')
    .order('created_at', { ascending: false })
    .limit(500)
    .returns<(Invoice & { client: { name: string } | null })[]>()
  if (error) throw new Error(`Failed to load invoices: ${error.message}`)
  return (data ?? []).map(({ client, ...row }) => ({ ...normalizeInvoice(row), client_name: client?.name ?? '' }))
}

/**
 * Prefill for a new client invoice: the client's effective price for its
 * billing cycle and the period following the current one.
 */
export async function getClientInvoiceDefaults(clientId: string): Promise<{
  amount: number
  periodStart: string
  periodEnd: string
  billingCycle: BillingCycle
} | null> {
  if (!UUID_PATTERN.test(clientId)) return null
  const session = await agencySession()
  if (!session) return null

  const details = await fetchClientSubscriptionDetails(session.supabase, clientId)
  if (!details) return null

  return {
    amount: details.price.current,
    ...nextPeriod(details.subscription.current_period_end, details.subscription.billing_cycle),
    billingCycle: details.subscription.billing_cycle,
  }
}

/** An invoice from the agency to one of its clients (numbered by the database). */
export async function createClientInvoice(input: ClientInvoiceInput): Promise<BillingActionResult> {
  const session = await agencySession()
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = clientInvoiceSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: String(parsed.error.issues[0]?.path[0] ?? '') }
  const values = parsed.data
  if (Date.parse(values.period_end) <= Date.parse(values.period_start)) {
    return { ok: false, error: 'validation', field: 'period_end' }
  }

  // RLS: org admins only see (and bill) their own clients
  const { data: client } = await session.supabase
    .from('clients')
    .select('id')
    .eq('id', values.client_id)
    .eq('organization_id', session.organizationId)
    .maybeSingle<{ id: string }>()
  if (!client) return { ok: false, error: 'notFound' }

  const { error } = await session.supabase.from('invoices').insert({
    organization_id: session.organizationId,
    client_id: values.client_id,
    billed_to: 'agency',
    amount: values.amount,
    period_start: values.period_start,
    period_end: values.period_end,
    status: values.status,
    notes: values.notes || null,
  })
  if (error) return fail(error, 'createClientInvoice')

  revalidateAgencyBilling()
  return { ok: true }
}

/** Records the client's payment; the client's subscription becomes active and moves on to the invoice's period. */
export async function markClientInvoicePaid(invoiceId: string, input: MarkPaidInput): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(invoiceId)) return { ok: false, error: 'notFound' }
  const session = await agencySession()
  if (!session) return { ok: false, error: 'forbidden' }

  const parsed = markPaidSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', field: String(parsed.error.issues[0]?.path[0] ?? '') }

  // The database only lets org admins pay their own agency's client invoices
  const { data, error } = await session.supabase.rpc('mark_invoice_paid', {
    p_invoice_id: invoiceId,
    p_payment_method: parsed.data.payment_method,
    p_payment_reference: parsed.data.payment_reference ?? '',
    p_paid_at: parsed.data.paid_at,
  })
  if (error) return fail(error, 'markClientInvoicePaid')
  if (data === 'not_found') return { ok: false, error: 'notFound' }
  if (data === 'invalid_status') return { ok: false, error: 'invalidStatus' }
  if (data !== 'ok') return { ok: false, error: 'forbidden' }

  revalidateAgencyBilling()
  return { ok: true }
}

/** Draft → sent, sent → overdue, or cancel one of the agency's client invoices. Paid invoices are final. */
export async function setClientInvoiceStatus(
  invoiceId: string,
  status: Exclude<InvoiceStatus, 'paid'>
): Promise<BillingActionResult> {
  if (!UUID_PATTERN.test(invoiceId)) return { ok: false, error: 'notFound' }
  if (!(['draft', 'sent', 'overdue', 'cancelled'] as string[]).includes(status)) return { ok: false, error: 'validation' }
  const session = await agencySession()
  if (!session) return { ok: false, error: 'forbidden' }

  const { data, error } = await session.supabase
    .from('invoices')
    .update({ status })
    .eq('id', invoiceId)
    .eq('organization_id', session.organizationId)
    .eq('billed_to', 'agency')
    .neq('status', 'paid')
    .select('id')
  if (error) return fail(error, 'setClientInvoiceStatus')
  if (!data?.length) return { ok: false, error: 'invalidStatus' }

  revalidateAgencyBilling()
  return { ok: true }
}
