import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * THE BUSINESS REMOVED OUR ACCESS IN WHATSAPP (account_update, PARTNER_REMOVED).
 * Every WhatsApp channel of that WABA is paused and its card says why
 * (connection_notice 'removed_by_business'), so the clinic sees a channel that
 * has stopped, not one that looks live while every send fails. Connecting the
 * number again clears it (src/lib/actions/whatsapp-connect.ts). The token stays
 * where it is: it no longer works, and a reconnect replaces it.
 * Facebook and Instagram have no such event; their deauthorize callback is
 * separate work, after the submission (decided 2026-11-09).
 */
export async function pauseRemovedWaba(supabase: SupabaseClient, wabaId: string): Promise<number> {
  const { data: secrets, error } = await supabase.from('channel_secrets').select('channel_id').eq('waba_id', wabaId).returns<{ channel_id: string }[]>()
  if (error) throw error
  if (secrets.length === 0) {
    console.warn('[whatsapp/removed] no channel for the WABA', { wabaId })
    return 0
  }
  const { data: paused, error: updateError } = await supabase
    .from('channels')
    .update({ is_active: false, connection_notice: 'removed_by_business' })
    .in(
      'id',
      secrets.map((s) => s.channel_id)
    )
    .eq('type', 'whatsapp')
    .select('id')
  if (updateError) throw updateError
  console.warn('[whatsapp/removed] the business removed our access: channels paused', { wabaId, channels: (paused ?? []).map((c) => c.id) })
  return (paused ?? []).length
}
