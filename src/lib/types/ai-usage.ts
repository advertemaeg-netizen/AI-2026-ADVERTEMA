import { z } from 'zod'

export const AI_USAGE_OPERATIONS = ['chat_reply', 'lead_analysis', 'embedding', 'playground', 'bot_preview'] as const
export type AiUsageOperation = (typeof AI_USAGE_OPERATIONS)[number]

/** Below this margin (share of the subscription's value) a client is flagged */
export const LOW_MARGIN_PCT = 30

/** One client over the chosen period (get_ai_usage_report) */
export type AiUsageClientRow = {
  client_id: string
  client_name: string
  organization_id: string
  organization_name: string
  org_type: 'agency' | 'direct'
  plan_id: string | null
  plan_slug: string | null
  plan_name: string | null
  plan_name_ar: string | null
  subscription_status: string | null
  /** EGP per month after custom pricing; null without a subscription */
  monthly_price: number | null
  requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
  /** Calls whose model had no price when they were logged */
  unpriced_requests: number
  /** Past 50 % of its price in AI cost this month */
  cost_alert: boolean
}

/** A client row with its money for the period */
export type AiUsageClientSummary = AiUsageClientRow & {
  cost_egp: number
  /** The subscription's value over the period (monthly price × days / 30) */
  value_egp: number | null
  margin_egp: number | null
  /** margin / value, in %; null without a value */
  margin_pct: number | null
  flag: 'negative' | 'low' | null
}

export type AiUsageOperationRow = {
  operation: AiUsageOperation
  requests: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
  unpriced_requests: number
}

/** Average per plan, to tune prices */
export type AiUsagePlanSummary = {
  plan_slug: string | null
  plan_name: string | null
  plan_name_ar: string | null
  clients: number
  /** Clients that used the AI in the period */
  active_clients: number
  avg_cost_egp: number
  /** avg_cost_egp scaled to a 30-day month */
  avg_monthly_cost_egp: number
  avg_monthly_price: number | null
  /** 100 − monthly cost / monthly price, in % */
  avg_margin_pct: number | null
}

export type ModelPrice = {
  model: string
  input_price_per_million: number
  output_price_per_million: number
  updated_at: string
}

export type UnpricedModel = { model: string; requests: number; last_used_at: string }

export type AiUsageOverview = {
  days: number
  usdToEgp: number
  totals: { requests: number; total_tokens: number; cost_usd: number; cost_egp: number; unpriced_requests: number }
  clients: AiUsageClientSummary[]
  operations: AiUsageOperationRow[]
  plans: AiUsagePlanSummary[]
  models: ModelPrice[]
  unpriced: UnpricedModel[]
}

export type AiUsageActionResult = { ok: true } | { ok: false; error: 'forbidden' | 'validation' | 'unknown' }

const price = z.number().min(0).max(10_000)

export const modelPriceSchema = z.object({
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/),
  input_price_per_million: price,
  output_price_per_million: price,
})

export type ModelPriceInput = z.infer<typeof modelPriceSchema>

export const exchangeRateSchema = z.number().gt(0).max(100_000)
