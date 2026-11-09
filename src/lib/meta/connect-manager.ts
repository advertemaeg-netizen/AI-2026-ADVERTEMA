import 'server-only'
import { canManage, getSession } from '@/lib/auth/session'
import { UUID_PATTERN } from '@/lib/types/clients'

/**
 * Who may connect a Meta channel for a client: a signed-in manager, not
 * impersonating, who can see the client (RLS). Shared by the Page and
 * Instagram connect (src/lib/actions/meta-connect.ts) and the WhatsApp one
 * (src/lib/actions/whatsapp-connect.ts); kept out of both 'use server'
 * files, where every export is callable from the browser.
 */
export async function manager(
  clientId: string
): Promise<{ ok: false; error: 'forbidden' | 'impersonating' } | { ok: true; supabase: Awaited<ReturnType<typeof getSession>>['supabase']; profile: NonNullable<Awaited<ReturnType<typeof getSession>>['profile']>; client: { id: string; name: string } }> {
  const { supabase, profile, impersonation } = await getSession()
  if (!profile) return { ok: false, error: 'forbidden' }
  if (impersonation) return { ok: false, error: 'impersonating' }
  if (!canManage(profile) || !UUID_PATTERN.test(clientId)) return { ok: false, error: 'forbidden' }
  // RLS: only clients this user can see
  const { data: client } = await supabase.from('clients').select('id, name').eq('id', clientId).maybeSingle<{ id: string; name: string }>()
  if (!client) return { ok: false, error: 'forbidden' }
  return { ok: true, supabase, profile, client }
}
