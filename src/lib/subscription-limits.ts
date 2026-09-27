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

/** The action error for a refused check, or null when allowed. */
export function limitError(check: LimitCheck | null): LimitError | null {
  if (!check || check.allowed) return null
  return check.reason === 'inactive' ? 'subscriptionInactive' : 'limitReached'
}

/** Maps the database backstop ("subscription_limit:<type>", hint = reason). */
export function limitErrorFromDb(error: { message?: string; hint?: string | null }): LimitError | null {
  if (!error.message?.startsWith('subscription_limit:')) return null
  return error.hint === 'inactive' ? 'subscriptionInactive' : 'limitReached'
}
