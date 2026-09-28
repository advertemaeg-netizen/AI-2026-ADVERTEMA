'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isSuperAdmin } from '@/lib/auth/permissions'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  exchangeRateSchema,
  LOW_MARGIN_PCT,
  modelPriceSchema,
  type AiUsageActionResult,
  type AiUsageClientRow,
  type AiUsageClientSummary,
  type AiUsageOperationRow,
  type AiUsageOverview,
  type AiUsagePlanSummary,
  type ModelPrice,
  type ModelPriceInput,
  type UnpricedModel,
} from '@/lib/types/ai-usage'

/**
 * What the AI costs the platform (ai_usage), against what each client's
 * subscription brings in. Costs are in USD as logged; EGP uses the rate
 * super admins set (platform_settings).
 */

const DAY = 24 * 60 * 60 * 1000
const DEFAULT_USD_TO_EGP = 50

// Postgres numeric/bigint can arrive as strings
const num = (value: unknown) => Number(value ?? 0)
const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value))
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits

async function superAdminSession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isSuperAdmin(profile.role)) return null
  return supabase
}

function revalidateAiUsage() {
  revalidatePath('/[locale]/admin', 'layout')
}

function summarizeClient(row: AiUsageClientRow, rate: number, days: number): AiUsageClientSummary {
  const cost_egp = round(row.cost_usd * rate)
  const value_egp = row.monthly_price === null ? null : round((row.monthly_price * days) / 30)
  const margin_egp = value_egp === null ? null : round(value_egp - cost_egp)
  const margin_pct = value_egp && margin_egp !== null ? round((margin_egp / value_egp) * 100, 1) : null
  const flag =
    (margin_egp !== null && margin_egp < 0) || (!value_egp && cost_egp > 0)
      ? 'negative'
      : margin_pct !== null && margin_pct < LOW_MARGIN_PCT && row.cost_usd > 0
        ? 'low'
        : null
  return { ...row, cost_egp, value_egp, margin_egp, margin_pct, flag }
}

function summarizePlans(clients: AiUsageClientSummary[], days: number): AiUsagePlanSummary[] {
  const groups = new Map<string, AiUsageClientSummary[]>()
  for (const client of clients) {
    const key = client.plan_slug ?? ''
    groups.set(key, [...(groups.get(key) ?? []), client])
  }
  return [...groups.values()]
    .map((rows): AiUsagePlanSummary => {
      const avg = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0)
      const prices = rows.map((r) => r.monthly_price).filter((p): p is number => p !== null)
      const avg_cost_egp = avg(rows.map((r) => r.cost_egp))
      const avg_monthly_cost_egp = days > 0 ? (avg_cost_egp * 30) / days : 0
      const avg_monthly_price = prices.length ? avg(prices) : null
      return {
        plan_slug: rows[0].plan_slug,
        plan_name: rows[0].plan_name,
        plan_name_ar: rows[0].plan_name_ar,
        clients: rows.length,
        active_clients: rows.filter((r) => r.requests > 0).length,
        avg_cost_egp: round(avg_cost_egp),
        avg_monthly_cost_egp: round(avg_monthly_cost_egp),
        avg_monthly_price: avg_monthly_price === null ? null : round(avg_monthly_price),
        avg_margin_pct: avg_monthly_price ? round((1 - avg_monthly_cost_egp / avg_monthly_price) * 100, 1) : null,
      }
    })
    .sort((a, b) => b.avg_monthly_cost_egp - a.avg_monthly_cost_egp)
}

/** Everything the admin AI usage page shows for [from, to). */
export async function getAiUsageOverview(range: { from: string; to: string }): Promise<AiUsageOverview | null> {
  const supabase = await superAdminSession()
  if (!supabase) return null
  const from = new Date(range.from)
  const to = new Date(range.to)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return null

  const [report, operations, settings, models, unpriced] = await Promise.all([
    supabase.rpc('get_ai_usage_report', { p_from: range.from, p_to: range.to }),
    supabase.rpc('get_ai_usage_by_operation', { p_from: range.from, p_to: range.to }),
    supabase.from('platform_settings').select('usd_to_egp').maybeSingle<{ usd_to_egp: number }>(),
    supabase.from('model_pricing').select('*').order('model').returns<ModelPrice[]>(),
    supabase.rpc('get_unpriced_ai_models'),
  ])
  for (const result of [report, operations, settings, models, unpriced]) {
    if (result.error) throw new Error(`Failed to load AI usage: ${result.error.message}`)
  }

  const rate = num(settings.data?.usd_to_egp) || DEFAULT_USD_TO_EGP
  const days = (to.getTime() - from.getTime()) / DAY

  const clients = ((report.data as AiUsageClientRow[] | null) ?? []).map((row) =>
    summarizeClient(
      {
        ...row,
        monthly_price: numOrNull(row.monthly_price),
        requests: num(row.requests),
        prompt_tokens: num(row.prompt_tokens),
        completion_tokens: num(row.completion_tokens),
        total_tokens: num(row.total_tokens),
        cost_usd: num(row.cost_usd),
        unpriced_requests: num(row.unpriced_requests),
      },
      rate,
      days
    )
  )
  const ops = ((operations.data as AiUsageOperationRow[] | null) ?? []).map((row) => ({
    ...row,
    requests: num(row.requests),
    prompt_tokens: num(row.prompt_tokens),
    completion_tokens: num(row.completion_tokens),
    total_tokens: num(row.total_tokens),
    cost_usd: num(row.cost_usd),
    unpriced_requests: num(row.unpriced_requests),
  }))
  const sum = (key: 'requests' | 'total_tokens' | 'cost_usd' | 'unpriced_requests') =>
    ops.reduce((total, row) => total + row[key], 0)

  return {
    days,
    usdToEgp: rate,
    totals: {
      requests: sum('requests'),
      total_tokens: sum('total_tokens'),
      cost_usd: sum('cost_usd'),
      cost_egp: round(sum('cost_usd') * rate),
      unpriced_requests: sum('unpriced_requests'),
    },
    clients,
    operations: ops,
    plans: summarizePlans(clients, days),
    models: (models.data ?? []).map((m) => ({
      ...m,
      input_price_per_million: num(m.input_price_per_million),
      output_price_per_million: num(m.output_price_per_million),
    })),
    unpriced: ((unpriced.data as UnpricedModel[] | null) ?? []).map((m) => ({ ...m, requests: num(m.requests) })),
  }
}

/** Tokens and cost of one organization's clients over the last `days` (admin org page). */
export async function getOrganizationAiUsage(
  organizationId: string,
  days = 30
): Promise<Record<string, { total_tokens: number; cost_usd: number }>> {
  const supabase = await superAdminSession()
  if (!supabase || !UUID_PATTERN.test(organizationId)) return {}
  const to = new Date()
  const { data, error } = await supabase.rpc('get_ai_usage_report', {
    p_from: new Date(to.getTime() - days * DAY).toISOString(),
    p_to: to.toISOString(),
    p_org_id: organizationId,
  })
  if (error) throw new Error(`Failed to load AI usage: ${error.message}`)
  return Object.fromEntries(
    ((data as AiUsageClientRow[] | null) ?? []).map((row) => [
      row.client_id,
      { total_tokens: num(row.total_tokens), cost_usd: num(row.cost_usd) },
    ])
  )
}

export async function setUsdToEgp(rate: number): Promise<AiUsageActionResult> {
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }
  const parsed = exchangeRateSchema.safeParse(rate)
  if (!parsed.success) return { ok: false, error: 'validation' }

  const { error } = await supabase.from('platform_settings').update({ usd_to_egp: parsed.data }).eq('id', true)
  if (error) {
    console.error('[ai-usage] exchange rate', error)
    return { ok: false, error: 'unknown' }
  }
  revalidateAiUsage()
  return { ok: true }
}

/** Adds or updates a model's price. Past calls keep the cost they were logged with. */
export async function saveModelPrice(input: ModelPriceInput): Promise<AiUsageActionResult> {
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }
  const parsed = modelPriceSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation' }

  const { data, error } = await supabase.rpc('upsert_model_pricing', {
    p_model: parsed.data.model,
    p_input: parsed.data.input_price_per_million,
    p_output: parsed.data.output_price_per_million,
  })
  if (error || data !== 'ok') {
    if (error) console.error('[ai-usage] model price', error)
    return { ok: false, error: data === 'forbidden' ? 'forbidden' : 'unknown' }
  }
  revalidateAiUsage()
  return { ok: true }
}

export async function deleteModelPrice(model: string): Promise<AiUsageActionResult> {
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }
  const { error } = await supabase.from('model_pricing').delete().eq('model', model)
  if (error) {
    console.error('[ai-usage] delete model price', error)
    return { ok: false, error: 'unknown' }
  }
  revalidateAiUsage()
  return { ok: true }
}
