import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { LeadVisit } from '@/lib/types/leads'

/**
 * Every lead of a conversation, oldest first: one per sales episode, so a
 * returning customer has several. With the caller's client, so RLS applies.
 */
export async function getConversationLeads(supabase: SupabaseClient, conversationId: string): Promise<LeadVisit[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, status, service_requested, appointment_at, ai_appointment, created_at')
    .eq('conversation_id', conversationId)
    // Leads only: RLS hides the rest from clients, this keeps a super admin's view the same
    .eq('is_complete', true)
    .order('created_at', { ascending: true })
    .returns<LeadVisit[]>()
  if (error) console.error('[leads] conversation leads', error)
  return data ?? []
}
