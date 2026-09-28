'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isSuperAdmin } from '@/lib/auth/permissions'
import { SELECTED_CLIENT_COOKIE } from '@/lib/auth/client-context'
import {
  IMPERSONATION_COOKIE,
  IMPERSONATION_COOKIE_OPTIONS,
  signImpersonationCookie,
  type Impersonation,
} from '@/lib/auth/impersonation'
import { UUID_PATTERN } from '@/lib/types/clients'
import type { ImpersonationLogEntry, ImpersonationResult } from '@/lib/types/impersonation'

/**
 * A super admin opening a customer's account to support it: read-only,
 * except a conversation's status and assignee. The database enforces the
 * same (see the impersonation migration).
 */

/** Opens `orgId`'s dashboard for the super admin (ending any other session). */
export async function startImpersonation(orgId: string): Promise<ImpersonationResult> {
  if (typeof orgId !== 'string' || !UUID_PATTERN.test(orgId)) return { ok: false, error: 'notFound' }
  const { supabase, profile, impersonation } = await getSession()
  // Already viewing an account: still a super admin
  if (!profile || !(isSuperAdmin(profile.role) || impersonation)) return { ok: false, error: 'forbidden' }

  const { data: sessionId, error } = await supabase.rpc('start_impersonation', { p_org_id: orgId })
  if (error) {
    console.error('[impersonation] start', error)
    return { ok: false, error: 'unknown' }
  }
  // Null: not a super admin after all, or no such organization
  if (!sessionId) return { ok: false, error: 'notFound' }

  const store = await cookies()
  store.set(IMPERSONATION_COOKIE, signImpersonationCookie(sessionId as string, profile.id), IMPERSONATION_COOKIE_OPTIONS)
  // Start from "all clients" rather than a pick made in another account
  store.delete(SELECTED_CLIENT_COOKIE)
  revalidatePath('/[locale]', 'layout')
  return { ok: true }
}

/** Ends the session (if any): back to the super admin's own view. Also run on sign-out. */
export async function endImpersonation(): Promise<{ ok: boolean }> {
  const { supabase, profile } = await getSession()
  const store = await cookies()
  if (store.has(IMPERSONATION_COOKIE)) {
    store.delete(IMPERSONATION_COOKIE)
    store.delete(SELECTED_CLIENT_COOKIE)
  }
  if (!profile) return { ok: true }

  // A no-op for anyone without an open session
  const { error } = await supabase.rpc('end_impersonation')
  if (error) {
    console.error('[impersonation] end', error)
    return { ok: false }
  }
  revalidatePath('/[locale]', 'layout')
  return { ok: true }
}

/** The session the super admin is in, or null. */
export async function getImpersonationContext(): Promise<Impersonation | null> {
  return (await getSession()).impersonation
}

/** The latest sessions, for the admin panel (super admins only). */
export async function getImpersonationLog(limit = 20): Promise<ImpersonationLogEntry[]> {
  const { supabase, profile } = await getSession()
  if (!profile || !isSuperAdmin(profile.role)) return []

  const { data, error } = await supabase.rpc('get_impersonation_log', { p_limit: limit })
  if (error) throw new Error(`Failed to load the impersonation log: ${error.message}`)
  return ((data as ImpersonationLogEntry[] | null) ?? []).map((row) => ({
    ...row,
    actions_count: Number(row.actions_count ?? 0),
  }))
}
