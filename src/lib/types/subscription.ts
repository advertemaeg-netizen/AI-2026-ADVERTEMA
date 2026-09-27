import { z } from 'zod'
import { UUID_PATTERN } from './clients'

export const LIMIT_TYPES = ['messages', 'clients', 'team_members', 'channels', 'knowledge_docs'] as const
export type LimitType = (typeof LIMIT_TYPES)[number]

export const PLAN_TYPES = ['agency', 'business'] as const
export type PlanType = (typeof PLAN_TYPES)[number]

export const BILLING_CYCLES = ['monthly', 'yearly'] as const
export type BillingCycle = (typeof BILLING_CYCLES)[number]

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
} as const satisfies Record<LimitType, string>

export type PlanLimits = { [K in LimitType as (typeof LIMIT_COLUMNS)[K]]: number | null }

export type Plan = PlanLimits & {
  id: string
  slug: string
  name: string
  name_ar: string
  plan_type: PlanType
  price_monthly: number
  price_yearly: number
  features: PlanFeature[]
  is_active: boolean
  sort_order: number
}

/** A plan with this organization's prices (custom pricing applied) */
export type AvailablePlan = Plan & { effective_monthly: number; effective_yearly: number }

export type UsageItem = {
  limit_type: LimitType
  used: number
  limit: number | null
  percentage: number | null
}

export type CustomPricing = {
  discount_type: 'percentage' | 'fixed_price'
  discount_percentage: number | null
  fixed_price_monthly: number | null
  fixed_price_yearly: number | null
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
    billing_cycle: BillingCycle
    current_period_start: string
    current_period_end: string
    trial_ends_at: string | null
    messages_period_start: string
    notes: string | null
  }
  plan: Plan
  custom_pricing: CustomPricing | null
  price: { monthly: number; yearly: number; current: number; base_current: number }
  usage: UsageItem[]
}

export type Invoice = {
  id: string
  organization_id: string
  organization_name?: string
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

export type LimitCheck = {
  allowed: boolean
  used: number
  limit: number | null
  percentage: number | null
  reason: 'ok' | 'limit_reached' | 'inactive'
}

export type UsageAlert = { limit_type: LimitType; threshold: number; used: number; limit: number }

/** One row of the admin subscriptions table */
export type SubscriptionRow = {
  organization_id: string
  organization_name: string
  organization_active: boolean
  subscription_id: string
  status: SubscriptionStatus
  usable: boolean
  billing_cycle: BillingCycle
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
  price_yearly: price,
  messages_limit: limit,
  clients_limit: limit,
  team_members_limit: limit,
  channels_limit: limit,
  knowledge_docs_limit: limit,
  features: z.array(planFeatureSchema).max(20, 'tooMany'),
  is_active: z.boolean(),
})

export type PlanInput = z.infer<typeof planSchema>

export const customPricingSchema = z
  .object({
    discount_type: z.enum(['percentage', 'fixed_price']),
    discount_percentage: z.number().gt(0).max(100).nullable(),
    fixed_price_monthly: price.nullable(),
    fixed_price_yearly: price.nullable(),
    reason: z.string().trim().max(200).nullable(),
    valid_until: z.iso.datetime({ offset: true }).nullable(),
  })
  .refine(
    (v) =>
      v.discount_type === 'percentage'
        ? v.discount_percentage !== null
        : v.fixed_price_monthly !== null || v.fixed_price_yearly !== null,
    { message: 'priceRequired' }
  )

export type CustomPricingInput = z.infer<typeof customPricingSchema>

export const changePlanSchema = z.object({
  plan_id: uuid,
  billing_cycle: z.enum(BILLING_CYCLES),
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

export const markPaidSchema = z.object({
  payment_method: z.enum(PAYMENT_METHODS),
  payment_reference: z.string().trim().max(120).nullable(),
  paid_at: z.iso.datetime({ offset: true }),
})

export type MarkPaidInput = z.infer<typeof markPaidSchema>
