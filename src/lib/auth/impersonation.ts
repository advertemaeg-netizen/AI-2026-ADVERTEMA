import 'server-only'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { OrgType } from '@/lib/auth/client-context'

/**
 * A super admin viewing a customer's account (see the impersonation
 * migration). The session id lives in a signed httpOnly cookie bound to the
 * super admin; the database row is what counts, so an ended or expired
 * session's cookie is ignored.
 */

export const IMPERSONATION_COOKIE = 'impersonation'

// Matches the database's 8 hour limit
const MAX_AGE = 8 * 60 * 60

export const IMPERSONATION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: MAX_AGE,
} as const

export type Impersonation = {
  id: string
  organizationId: string
  organizationName: string
  orgType: OrgType
  startedAt: string
}

function signingKey() {
  const secret = process.env.IMPERSONATION_SECRET || process.env.SUPABASE_SECRET_KEY
  if (!secret) throw new Error('SUPABASE_SECRET_KEY is not set')
  // Its own key, so the cookie signature says nothing about the secret itself
  return createHash('sha256').update(`impersonation-cookie:${secret}`).digest()
}

function signature(sessionId: string, userId: string) {
  return createHmac('sha256', signingKey()).update(`${sessionId}.${userId}`).digest('base64url')
}

export function signImpersonationCookie(sessionId: string, userId: string) {
  return `${sessionId}.${signature(sessionId, userId)}`
}

/** The session id in the cookie, if its signature holds for this user. */
async function readSessionId(userId: string): Promise<string | null> {
  const value = (await cookies()).get(IMPERSONATION_COOKIE)?.value
  if (!value) return null
  const [sessionId, sig] = value.split('.')
  if (!sessionId || !sig) return null
  const expected = Buffer.from(signature(sessionId, userId))
  const actual = Buffer.from(sig)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return sessionId
}

/**
 * The super admin's open session, for this request. Without a valid cookie,
 * any session left open (another browser, a lost cookie) is ended: the
 * database would otherwise keep treating the super admin as that
 * organization's admin.
 */
export async function resolveImpersonation(supabase: SupabaseClient, userId: string): Promise<Impersonation | null> {
  const sessionId = await readSessionId(userId)
  if (sessionId) {
    const { data, error } = await supabase
      .rpc('get_active_impersonation', { p_session_id: sessionId })
      .maybeSingle<{
        id: string
        target_organization_id: string
        organization_name: string
        org_type: string
        started_at: string
      }>()
    if (error) console.error('[impersonation] active session', error)
    if (data) {
      return {
        id: data.id,
        organizationId: data.target_organization_id,
        organizationName: data.organization_name,
        orgType: data.org_type === 'direct' ? 'direct' : 'agency',
        startedAt: data.started_at,
      }
    }
  }

  const { error } = await supabase.rpc('end_impersonation')
  if (error) console.error('[impersonation] end stale sessions', error)
  return null
}

/** Counts a support action (a conversation's status or assignee) done while viewing the account. */
export async function recordImpersonationAction(supabase: SupabaseClient, impersonation: Impersonation | null) {
  if (!impersonation) return
  const { error } = await supabase.rpc('record_impersonation_action', { p_session_id: impersonation.id })
  if (error) console.error('[impersonation] record action', error)
}
