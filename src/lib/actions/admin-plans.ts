'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isSuperAdmin } from '@/lib/auth/permissions'
import { normalizePlan } from '@/lib/subscription-data'
import { UUID_PATTERN } from '@/lib/types/clients'
import { PLAN_TYPES, planSchema, type Plan, type PlanInput, type PlanType } from '@/lib/types/subscription'

export type PlanActionError = 'forbidden' | 'validation' | 'slugTaken' | 'typeInUse' | 'notFound' | 'unknown'
export type PlanActionResult = { ok: true; id: string } | { ok: false; error: PlanActionError; field?: string }

const PLAN_PATHS = [
  '/[locale]/admin/plans',
  '/[locale]/admin/subscriptions',
  '/[locale]/dashboard/subscription',
  '/[locale]/dashboard/billing',
  '/[locale]/dashboard/clients/[clientId]/subscription',
]

async function superAdminSession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isSuperAdmin(profile.role)) return null
  return supabase
}

function revalidatePlans() {
  for (const path of PLAN_PATHS) revalidatePath(path, 'page')
}

function dbError(error: { code?: string; message: string }): PlanActionResult {
  if (error.code === '23505') return { ok: false, error: 'slugTaken', field: 'slug' }
  // Organizations or clients are on this plan: it can't move to the other level
  if (error.message?.includes('plan_type_in_use')) return { ok: false, error: 'typeInUse', field: 'plan_type' }
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error('[admin-plans]', error)
  return { ok: false, error: 'unknown' }
}

function parse(input: PlanInput) {
  const parsed = planSchema.safeParse(input)
  if (parsed.success) return { ok: true as const, values: parsed.data }
  return { ok: false as const, field: String(parsed.error.issues[0]?.path[0] ?? '') }
}

/** Every plan (active or not), ordered for display. */
export async function getPlans(): Promise<Plan[]> {
  const supabase = await superAdminSession()
  if (!supabase) return []

  const { data, error } = await supabase
    .from('plans')
    .select('*')
    .order('plan_type')
    .order('sort_order')
    .order('price_monthly')
    .returns<Plan[]>()
  if (error) throw new Error(`Failed to load plans: ${error.message}`)
  return (data ?? []).map(normalizePlan)
}

export async function createPlan(input: PlanInput): Promise<PlanActionResult> {
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }

  const parsed = parse(input)
  if (!parsed.ok) return { ok: false, error: 'validation', field: parsed.field }

  // New plans go last in their tab
  const { data: last } = await supabase
    .from('plans')
    .select('sort_order')
    .eq('plan_type', parsed.values.plan_type)
    .order('sort_order', { ascending: false })
    .limit(1)
    .maybeSingle<{ sort_order: number }>()

  const { data, error } = await supabase
    .from('plans')
    .insert({ ...parsed.values, sort_order: (last?.sort_order ?? 0) + 1 })
    .select('id')
    .single<{ id: string }>()
  if (error) return dbError(error)

  revalidatePlans()
  return { ok: true, id: data.id }
}

export async function updatePlan(planId: string, input: PlanInput): Promise<PlanActionResult> {
  if (!UUID_PATTERN.test(planId)) return { ok: false, error: 'notFound' }
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }

  const parsed = parse(input)
  if (!parsed.ok) return { ok: false, error: 'validation', field: parsed.field }

  const { data, error } = await supabase
    .from('plans')
    .update(parsed.values)
    .eq('id', planId)
    .select('id')
    .maybeSingle<{ id: string }>()
  if (error) return dbError(error)
  if (!data) return { ok: false, error: 'notFound' }

  revalidatePlans()
  return { ok: true, id: data.id }
}

/** Inactive plans stay on existing subscriptions but aren't offered anymore. */
export async function togglePlanActive(planId: string): Promise<PlanActionResult> {
  if (!UUID_PATTERN.test(planId)) return { ok: false, error: 'notFound' }
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }

  const { data: plan } = await supabase.from('plans').select('is_active').eq('id', planId).maybeSingle<{ is_active: boolean }>()
  if (!plan) return { ok: false, error: 'notFound' }

  const { error } = await supabase.from('plans').update({ is_active: !plan.is_active }).eq('id', planId)
  if (error) return dbError(error)

  revalidatePlans()
  return { ok: true, id: planId }
}

/** Sets sort_order 1..n in the given order, for one plan type. */
export async function reorderPlans(planType: PlanType, orderedIds: string[]): Promise<PlanActionResult> {
  if (!(PLAN_TYPES as readonly string[]).includes(planType)) return { ok: false, error: 'validation' }
  if (orderedIds.length === 0 || orderedIds.length > 100 || !orderedIds.every((id) => UUID_PATTERN.test(id))) {
    return { ok: false, error: 'validation' }
  }
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }

  const results = await Promise.all(
    orderedIds.map((id, index) =>
      supabase.from('plans').update({ sort_order: index + 1 }).eq('id', id).eq('plan_type', planType)
    )
  )
  const failed = results.find((r) => r.error)
  if (failed?.error) return dbError(failed.error)

  revalidatePlans()
  return { ok: true, id: orderedIds[0] }
}
