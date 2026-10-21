'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  branchInputSchema,
  closureDates,
  closureInputSchema,
  type Branch,
  type BranchActionResult,
  type BranchClosure,
  type BranchInput,
  type ClosureInput,
} from '@/lib/types/branches'

const BRANCHES_PATH = '/[locale]/dashboard/clients/[clientId]/branches'
const BRANCH_COLUMNS = 'id, client_id, name, timezone, capacity_per_slot, slot_minutes, business_hours, is_active, created_at'

type BranchRow = Omit<Branch, 'closures' | 'leadCount' | 'upcomingCount'>

function dbError(error: { code?: string; message: string }): BranchActionResult {
  // branches_client_name: a branch of this client already reads as this name
  if (error.code === '23505') return { ok: false, error: 'duplicateName', fieldErrors: { name: 'duplicateName' } }
  // A lead still points at the branch (leads_branch_fkey)
  if (error.code === '23503') return { ok: false, error: 'hasLeads' }
  // 42501 = insufficient_privilege (RLS rejected the write)
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error('[branches]', error)
  return { ok: false, error: 'unknown' }
}

type Session = Awaited<ReturnType<typeof getSession>>

/** The signed-in manager's session, or why there is none */
async function managerSession(): Promise<
  { error: 'impersonating' | 'unauthorized' | 'forbidden' } | { error?: undefined; supabase: Session['supabase'] }
> {
  if (await isImpersonating()) return { error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { error: 'unauthorized' }
  if (!canManage(profile)) return { error: 'forbidden' }
  return { supabase }
}

function fieldErrors(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {}
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'form'
    errors[key] ??= issue.message
  }
  return errors
}

/** A client's branches with their closures and how many leads each holds. RLS: clients the user can see. */
export async function getBranches(clientId: string): Promise<Branch[]> {
  if (!UUID_PATTERN.test(clientId)) return []
  const { supabase, profile } = await getSession()
  // Managed with the other client settings: team members don't see the page
  if (!profile || !canManage(profile)) return []

  const [branches, closures, leads] = await Promise.all([
    supabase.from('branches').select(BRANCH_COLUMNS).eq('client_id', clientId).order('created_at').returns<BranchRow[]>(),
    supabase
      .from('branch_closures')
      .select('id, branch_id, date, reason')
      .eq('client_id', clientId)
      // From a week ago: what is coming, and what just passed
      .gte('date', new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10))
      .order('date')
      .returns<(BranchClosure & { branch_id: string })[]>(),
    supabase
      .from('leads')
      .select('branch_id, appointment_at')
      .eq('client_id', clientId)
      // Leads only: RLS hides the rest from clients, this keeps a super admin's counts the same
      .eq('is_complete', true)
      .not('branch_id', 'is', null)
      .returns<{ branch_id: string; appointment_at: string | null }[]>(),
  ])
  if (branches.error) throw new Error(`Failed to load branches: ${branches.error.message}`)
  if (closures.error) throw new Error(`Failed to load closures: ${closures.error.message}`)
  if (leads.error) throw new Error(`Failed to load branch leads: ${leads.error.message}`)

  const now = Date.now()
  return branches.data.map((branch) => {
    const mine = leads.data.filter((lead) => lead.branch_id === branch.id)
    return {
      ...branch,
      closures: closures.data.filter((closure) => closure.branch_id === branch.id).map(({ id, date, reason }) => ({ id, date, reason })),
      leadCount: mine.length,
      upcomingCount: mine.filter((lead) => lead.appointment_at && new Date(lead.appointment_at).getTime() > now).length,
    }
  })
}

export async function createBranchAction(clientId: string, input: BranchInput): Promise<BranchActionResult> {
  const session = await managerSession()
  if (session.error) return { ok: false, error: session.error }
  if (!UUID_PATTERN.test(clientId)) return { ok: false, error: 'notFound' }
  const parsed = branchInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', fieldErrors: fieldErrors(parsed.error.issues) }
  const { supabase } = session

  // RLS: only clients this user can see
  const { data: client } = await supabase.from('clients').select('id').eq('id', clientId).maybeSingle<{ id: string }>()
  if (!client) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase
    .from('branches')
    .insert({ client_id: clientId, ...parsed.data })
    .select('id')
    .single<{ id: string }>()
  if (error) return dbError(error)

  const linkedLeads = await linkLeads(supabase, data.id)
  revalidatePath(BRANCHES_PATH, 'page')
  return { ok: true, linkedLeads }
}

export async function updateBranchAction(branchId: string, input: BranchInput): Promise<BranchActionResult> {
  const session = await managerSession()
  if (session.error) return { ok: false, error: session.error }
  if (!UUID_PATTERN.test(branchId)) return { ok: false, error: 'notFound' }
  const parsed = branchInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', fieldErrors: fieldErrors(parsed.error.issues) }
  const { supabase } = session

  const { data, error } = await supabase.from('branches').update(parsed.data).eq('id', branchId).select('id')
  if (error) return dbError(error)
  // RLS filters out rows the user can't touch, which shows up as zero rows
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  // A new name may now be the one leads were written with
  const linkedLeads = await linkLeads(supabase, branchId)
  revalidatePath(BRANCHES_PATH, 'page')
  return { ok: true, linkedLeads }
}

/** Deletes a branch nobody was ever booked at. One with leads is deactivated instead (the database refuses). */
export async function deleteBranchAction(branchId: string): Promise<BranchActionResult> {
  const session = await managerSession()
  if (session.error) return { ok: false, error: session.error }
  if (!UUID_PATTERN.test(branchId)) return { ok: false, error: 'notFound' }
  const { supabase } = session

  // Asked first, not left to the foreign key: on the error path the visitor
  // would get "unknown" from any other cause too
  const { count, error: countError } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('branch_id', branchId)
  if (countError) return dbError(countError)
  if (count) return { ok: false, error: 'hasLeads' }

  const { data, error } = await supabase.from('branches').delete().eq('id', branchId).select('id')
  if (error) return dbError(error)
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(BRANCHES_PATH, 'page')
  return { ok: true }
}

/**
 * Closes one or more branches of a client for every day from `from` to `to`.
 * A day already closed stays as it is (its reason too).
 */
export async function addClosuresAction(clientId: string, input: ClosureInput): Promise<BranchActionResult> {
  const session = await managerSession()
  if (session.error) return { ok: false, error: session.error }
  if (!UUID_PATTERN.test(clientId)) return { ok: false, error: 'notFound' }
  const parsed = closureInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation', fieldErrors: fieldErrors(parsed.error.issues) }
  const { supabase } = session
  const { from, to, reason, branchIds } = parsed.data

  // Only this client's branches, and only ones RLS lets the user see
  const { data: branches, error: branchError } = await supabase
    .from('branches')
    .select('id')
    .eq('client_id', clientId)
    .in('id', branchIds)
    .returns<{ id: string }[]>()
  if (branchError) return dbError(branchError)
  if (branches.length !== new Set(branchIds).size) return { ok: false, error: 'notFound' }

  const rows = branches.flatMap((branch) =>
    closureDates(from, to).map((date) => ({ client_id: clientId, branch_id: branch.id, date, reason: reason || null }))
  )
  const { data, error } = await supabase
    .from('branch_closures')
    .upsert(rows, { onConflict: 'branch_id,date', ignoreDuplicates: true })
    .select('id')
  if (error) return dbError(error)

  revalidatePath(BRANCHES_PATH, 'page')
  return { ok: true, added: data?.length ?? 0 }
}

export async function deleteClosureAction(closureId: string): Promise<BranchActionResult> {
  const session = await managerSession()
  if (session.error) return { ok: false, error: session.error }
  if (!UUID_PATTERN.test(closureId)) return { ok: false, error: 'notFound' }

  const { data, error } = await session.supabase.from('branch_closures').delete().eq('id', closureId).select('id')
  if (error) return dbError(error)
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(BRANCHES_PATH, 'page')
  return { ok: true }
}

/** link_leads_to_branch: the client's unplaced leads whose branch reads as this one's name. Never fails the save. */
async function linkLeads(supabase: Awaited<ReturnType<typeof getSession>>['supabase'], branchId: string) {
  const { data, error } = await supabase.rpc('link_leads_to_branch', { p_branch_id: branchId })
  if (error) {
    console.error('[branches] linking leads by name failed', error)
    return 0
  }
  return (data as number | null) ?? 0
}
