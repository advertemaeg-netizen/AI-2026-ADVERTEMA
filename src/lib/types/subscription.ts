import { z } from 'zod'
import { UUID_PATTERN } from './clients'

export const LIMIT_TYPES = ['messages', 'clients', 'team_members', 'channels', 'knowledge_docs', 'knowledge_chunks'] as const
export type LimitType = (typeof LIMIT_TYPES)[number]

export const PLAN_TYPES = ['agency', 'business'] as const
export type PlanType = (typeof PLAN_TYPES)[number]

/**
 * Two billing levels: the organization (agency plan, paid to the platform)
 * and each client (business plan, paid to the agency). Knowledge chunks are
 * limited on both: per client, and for all of an agency's clients together.
 */
export const ORG_LIMIT_TYPES = ['clients', 'team_members', 'knowledge_chunks'] as const satisfies readonly LimitType[]
export const CLIENT_LIMIT_TYPES = [
  'messages',
  'channels',
  'knowledge_docs',
  'knowledge_chunks',
  'team_members',
] as const satisfies readonly LimitType[]
export type OrgLimitType = (typeof ORG_LIMIT_TYPES)[number]
export type ClientLimitType = (typeof CLIENT_LIMIT_TYPES)[number]

/** The limits each plan type sets (the others don't apply to it) */
export const PLAN_LIMIT_TYPES: Record<PlanType, readonly LimitType[]> = {
  agency: ORG_LIMIT_TYPES,
  business: CLIENT_LIMIT_TYPES,
}

/**
 * platform: from the platform to an agency, or to a direct business (then
 * with its client_id); agency: from an agency to its client
 */
export const BILLED_TO = ['platform', 'agency'] as const
export type BilledTo = (typeof BILLED_TO)[number]

export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'cancelled'] as const
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number]

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export const PAYMENT_METHODS = ['bank_transfer', 'instapay', 'vodafone_cash', 'cash', 'fawry', 'cheque', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** Usage share at which a limit warns, then turns critical */
export const WARN_AT = 80
export const CRITICAL_AT = 90

export type PlanFeature = { ar: string; en: string }

/** `<type>_limit` column for each limit type; null = unlimited */
export const LIMIT_COLUMNS = {
  messages: 'messages_limit',
  clients: 'clients_limit',
  team_members: 'team_members_limit',
  channels: 'channels_limit',
  knowledge_docs: 'knowledge_docs_limit',
  knowledge_chunks: 'knowledge_chunks_limit',
} as const satisfies Record<LimitType, string>

export type PlanLimits = { [K in LimitType as (typeof LIMIT_COLUMNS)[K]]: number | null }

export type Plan = PlanLimits & {
  id: string
  slug: string
  name: string
  name_ar: string
  plan_type: PlanType
  /** All plans are billed monthly */
  price_monthly: number
  /** Biggest knowledge file one upload may be; null = the platform's cap */
  max_file_size_mb: number | null
  features: PlanFeature[]
  is_active: boolean
  sort_order: number
}

/** A plan with this organization's price (custom pricing applied) */
export type AvailablePlan = Plan & { effective_monthly: number }

export type UsageItem = {
  limit_type: LimitType
  used: number
  limit: number | null
  percentage: number | null
  /** Messages only, on client subscriptions: analysed for leads past the limit */
  lead_capture_used?: number
}

export type CustomPricing = {
  discount_type: 'percentage' | 'fixed_price'
  discount_percentage: number | null
  fixed_price_monthly: number | null
  plan_id: string | null
  reason: string | null
  valid_until: string | null
  created_at: string
  /** Valid now and for the current plan */
  applies: boolean
}

export type SubscriptionDetails = {
  subscription: {
    id: string
    organization_id: string
    status: SubscriptionStatus
    usable: boolean
    current_period_start: string
    current_period_end: string
    trial_ends_at: string | null
    /** Client subscriptions only (organizations have no message allowance) */
    messages_period_start: string | null
    notes: string | null
  }
  plan: Plan
  custom_pricing: CustomPricing | null
  /** Monthly: the plan's price, and after custom pricing */
  price: { current: number; base: number }
  usage: UsageItem[]
}

/** One client's subscription (get_client_subscription_details) */
export type ClientSubscriptionDetails = Omit<SubscriptionDetails, 'subscription'> & {
  subscription: SubscriptionDetails['subscription'] & {
    client_id: string
    /** The agency's own subscription is usable (clients stop with it) */
    agency_usable: boolean
  }
  client: { id: string; name: string }
}

export type Invoice = {
  id: string
  organization_id: string
  organization_name?: string
  /** Set on invoices from an agency to its client */
  client_id: string | null
  client_name?: string
  billed_to: BilledTo
  subscription_id: string | null
  invoice_number: string
  amount: number
  currency: string
  period_start: string
  period_end: string
  status: InvoiceStatus
  paid_at: string | null
  payment_method: string | null
  payment_reference: string | null
  notes: string | null
  created_at: string
}

/**
 * Past the plan's monthly messages the bot stops replying, but visitor
 * messages are still analysed for leads until the total reaches this many
 * times the limit. The messages past the limit are counted separately
 * (client_subscriptions.lead_capture_used, see claim_lead_capture, which
 * allows one more plan's worth).
 */
export const LEAD_CAPTURE_LIMIT_FACTOR = 2

/** Messages still analysed for leads, for a client already at its message limit */
export function leadCaptureRemaining(limit: number, captureUsed: number): number {
  return Math.max(limit * (LEAD_CAPTURE_LIMIT_FACTOR - 1) - captureUsed, 0)
}

export type LimitCheck = {
  allowed: boolean
  used: number
  limit: number | null
  percentage: number | null
  reason: 'ok' | 'limit_reached' | 'inactive'
}

/** client_id null: an organization limit */
export type UsageAlert = {
  limit_type: LimitType
  threshold: number
  used: number
  limit: number
  client_id: string | null
  client_name: string | null
}

/** One row of the admin subscriptions table */
export type SubscriptionRow = {
  organization_id: string
  organization_name: string
  organization_active: boolean
  subscription_id: string
  status: SubscriptionStatus
  usable: boolean
  plan_id: string
  plan_slug: string
  plan_name: string
  plan_name_ar: string
  plan_type: PlanType
  base_price: number
  effective_price: number
  has_custom_pricing: boolean
  custom_pricing_reason: string | null
  current_period_end: string
  trial_ends_at: string | null
  usage: UsageItem[]
}

/** One client of the agency (dashboard billing page) */
export type ClientBillingRow = {
  client_id: string
  client_name: string
  client_status: string
  subscription_id: string
  status: SubscriptionStatus
  usable: boolean
  plan_id: string
  plan_slug: string
  plan_name: string
  plan_name_ar: string
  base_price: number
  effective_price: number
  has_custom_pricing: boolean
  current_period_start: string
  current_period_end: string
  trial_ends_at: string | null
  usage: UsageItem[]
  open_invoices: number
  open_amount: number
}

/** One row of the admin "client subscriptions" tab */
export type ClientSubscriptionRow = {
  client_id: string
  client_name: string
  organization_id: string
  organization_name: string
  organization_active: boolean
  subscription_id: string
  status: SubscriptionStatus
  usable: boolean
  plan_id: string
  plan_slug: string
  plan_name: string
  plan_name_ar: string
  base_price: number
  effective_price: number
  has_custom_pricing: boolean
  custom_pricing_reason: string | null
  current_period_end: string
  trial_ends_at: string | null
  usage: UsageItem[]
}

export type BillingActionError = 'forbidden' | 'validation' | 'notFound' | 'invalidStatus' | 'impersonating' | 'unknown'
export type BillingActionResult = { ok: true } | { ok: false; error: BillingActionError; field?: string }

/** Errors the limited actions (clients, channels, files, invites) can add */
export type LimitError = 'limitReached' | 'subscriptionInactive'

// ---------------------------------------------------------------------------
// Admin forms (validated again on the server)
// ---------------------------------------------------------------------------

const uuid = z.string().regex(UUID_PATTERN)
const limit = z.number().int().min(0).max(100_000_000).nullable()
const price = z.number().min(0).max(100_000_000)

export const planFeatureSchema = z.object({
  ar: z.string().trim().min(1, 'required').max(120, 'tooLong'),
  en: z.string().trim().min(1, 'required').max(120, 'tooLong'),
})

export const planSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9]+([_-][a-z0-9]+)*$/, 'slugInvalid')
    .max(60, 'tooLong'),
  name: z.string().trim().min(1, 'required').max(80, 'tooLong'),
  name_ar: z.string().trim().min(1, 'required').max(80, 'tooLong'),
  plan_type: z.enum(PLAN_TYPES),
  price_monthly: price,
  messages_limit: limit,
  clients_limit: limit,
  team_members_limit: limit,
  channels_limit: limit,
  knowledge_docs_limit: limit,
  knowledge_chunks_limit: limit,
  max_file_size_mb: z.number().int().min(1).max(100).nullable(),
  features: z.array(planFeatureSchema).max(20, 'tooMany'),
  is_active: z.boolean(),
})

export type PlanInput = z.infer<typeof planSchema>

export const customPricingSchema = z
  .object({
    discount_type: z.enum(['percentage', 'fixed_price']),
    discount_percentage: z.number().gt(0).max(100).nullable(),
    fixed_price_monthly: price.nullable(),
    reason: z.string().trim().max(200).nullable(),
    valid_until: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine(
    (v) =>
      v.discount_type === 'percentage'
        ? v.discount_percentage !== null
        : v.fixed_price_monthly !== null,
    { message: 'priceRequired' }
  )

export type CustomPricingInput = z.infer<typeof customPricingSchema>

export const changePlanSchema = z.object({
  plan_id: uuid,
  status: z.enum(SUBSCRIPTION_STATUSES),
  notes: z.string().trim().max(500).nullable(),
})

export type ChangePlanInput = z.infer<typeof changePlanSchema>

export const invoiceSchema = z.object({
  organization_id: uuid,
  amount: price,
  period_start: z.iso.datetime({ offset: true }),
  period_end: z.iso.datetime({ offset: true }),
  status: z.enum(['draft', 'sent']),
  notes: z.string().trim().max(500).nullable(),
})

export type InvoiceInput = z.infer<typeof invoiceSchema>

/** An agency's invoice to one of its clients */
export const clientInvoiceSchema = invoiceSchema.omit({ organization_id: true }).extend({ client_id: uuid })

export type ClientInvoiceInput = z.infer<typeof clientInvoiceSchema>

export const changeClientPlanSchema = z.object({
  plan_id: uuid,
})

export type ChangeClientPlanInput = z.infer<typeof changeClientPlanSchema>

export const markPaidSchema = z.object({
  payment_method: z.enum(PAYMENT_METHODS),
  payment_reference: z.string().trim().max(120).nullable(),
  paid_at: z.iso.datetime({ offset: true }),
})

export type MarkPaidInput = z.infer<typeof markPaidSchema>
