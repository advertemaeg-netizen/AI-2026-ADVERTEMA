import 'server-only'
import { createClient } from '@/lib/supabase/server'

export const MANAGER_ROLES = ['super_admin', 'org_admin', 'client_admin'] as const

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

export function canManage(profile: Profile) {
  return (MANAGER_ROLES as readonly string[]).includes(profile.role)
}
