import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { canManageClient } from '@/lib/auth/permissions'

export type Profile = {
  id: string
  role: string
  organization_id: string | null
}

export async function getSession() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { supabase, profile: null }

  const { data: profile } = await supabase
    .from('users')
    .select('id, role, organization_id')
    .eq('id', user.id)
    .single<Profile>()

  return { supabase, profile }
}

/** Shorthand for canManageClient(profile.role) */
export function canManage(profile: Profile) {
  return canManageClient(profile.role)
}
