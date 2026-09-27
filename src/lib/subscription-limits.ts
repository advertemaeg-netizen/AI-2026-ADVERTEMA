import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LimitCheck, LimitError, LimitType } from '@/lib/types/subscription'

/**
 * check_subscription_limit for one organization. null when the org has no
 * subscription (nothing to enforce) or the caller can't see it.
 */
export async function checkLimit(
  supabase: SupabaseClient,
  organizationId: string,
  limitType: LimitType
): Promise<LimitCheck | null> {
  const { data, error } = await supabase.rpc('check_subscription_limit', {
    p_org_id: organizationId,
    p_limit_type: limitType,
  })
  if (error) throw new Error(`check_subscription_limit failed: ${error.message}`)
  return (data as LimitCheck | null) ?? null
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
