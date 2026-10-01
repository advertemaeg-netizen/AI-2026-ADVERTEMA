import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClientLimitType, LimitCheck, LimitError, OrgLimitType } from '@/lib/types/subscription'
import type { KnowledgeQuota } from '@/lib/types/knowledge'

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
 * Whether a visitor message may be analysed for leads, counting it when it's
 * past the plan's messages:
 * - within the plan: yes
 * - past the limit: yes while the lead-capture allowance lasts; the message
 *   takes one from it, unless the bot answered it (`replied`: the reply that
 *   used up the plan's last message)
 * - no usable subscription, or a failed check: no (fails closed: no AI cost
 *   without a known-good subscription)
 */
export async function claimLeadAnalysis(supabase: SupabaseClient, clientId: string, replied: boolean): Promise<boolean> {
  try {
    const check = await checkClientLimit(supabase, clientId, 'messages')
    if (check === null || check.reason === 'inactive') return false
    if (check.reason !== 'limit_reached' || replied) return true
    const { data, error } = await supabase.rpc('claim_lead_capture', { p_client_id: clientId })
    if (error) throw new Error(`claim_lead_capture failed: ${error.message}`)
    return data === true
  } catch (error) {
    console.error('[subscription-limits] lead capture check', error)
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

/**
 * Room left in a client's knowledge base, in chunks, and the plan's cap on
 * one file (check_knowledge_quota). null when the caller can't see the client.
 */
export async function checkKnowledgeQuota(supabase: SupabaseClient, clientId: string): Promise<KnowledgeQuota | null> {
  const { data, error } = await supabase.rpc('check_knowledge_quota', { p_client_id: clientId })
  if (error) throw new Error(`check_knowledge_quota failed: ${error.message}`)
  if (!data) return null
  const raw = data as KnowledgeQuota
  const numOrNull = (value: unknown) => (value === null || value === undefined ? null : Number(value))
  return {
    used: Number(raw.used ?? 0),
    limit: numOrNull(raw.limit),
    org_used: numOrNull(raw.org_used),
    org_limit: numOrNull(raw.org_limit),
    available: numOrNull(raw.available),
    max_file_size_mb: numOrNull(raw.max_file_size_mb),
    usable: raw.usable !== false,
  }
}
