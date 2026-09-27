import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClientLimitType, LimitCheck, LimitError, OrgLimitType } from '@/lib/types/subscription'

async function rpcLimit(supabase: SupabaseClient, fn: string, args: Record<string, string>): Promise<LimitCheck | null> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(`${fn} failed: ${error.message}`)
  return (data as LimitCheck | null) ?? null
}

/**
 * Organization limits (clients, team members), from the agency plan. null
 * when the org has no subscription (nothing to enforce) or the caller can't
 * see it.
 */
export function checkOrgLimit(supabase: SupabaseClient, organizationId: string, limitType: OrgLimitType) {
  return rpcLimit(supabase, 'check_org_limit', { p_org_id: organizationId, p_limit_type: limitType })
}

/**
 * Client limits (messages, channels, knowledge files, team members), from
 * the client's business plan. Refused as inactive when either the client's
 * or its agency's subscription can't be used.
 */
export function checkClientLimit(supabase: SupabaseClient, clientId: string, limitType: ClientLimitType) {
  return rpcLimit(supabase, 'check_client_limit', { p_client_id: clientId, p_limit_type: limitType })
}

/**
 * Whether the client's subscription (and its agency's) can be used at all,
 * whatever its quotas. Fails closed: no subscription, or a failed check,
 * counts as inactive.
 */
export async function clientSubscriptionActive(supabase: SupabaseClient, clientId: string): Promise<boolean> {
  try {
    const check = await checkClientLimit(supabase, clientId, 'messages')
    return check !== null && check.reason !== 'inactive'
  } catch (error) {
    console.error('[subscription-limits] subscription check', error)
    return false
  }
}

/** The action error for a refused check, or null when allowed. */
export function limitError(check: LimitCheck | null): LimitError | null {
  if (!check || check.allowed) return null
  return check.reason === 'inactive' ? 'subscriptionInactive' : 'limitReached'
}

/**
 * limitError for a check that may itself fail: 'unknown' (logged) instead of
 * throwing, so actions refuse cleanly rather than crash the page.
 */
export async function guardLimit(check: Promise<LimitCheck | null>): Promise<LimitError | 'unknown' | null> {
  try {
    return limitError(await check)
  } catch (error) {
    console.error('[subscription-limits]', error)
    return 'unknown'
  }
}

/** Maps the database backstop ("subscription_limit:<type>", hint = reason). */
export function limitErrorFromDb(error: { message?: string; hint?: string | null }): LimitError | null {
  if (!error.message?.startsWith('subscription_limit:')) return null
  return error.hint === 'inactive' ? 'subscriptionInactive' : 'limitReached'
}
