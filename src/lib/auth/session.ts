import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { canManageClient } from '@/lib/auth/permissions'

export type Profile = {
  id: string
  role: string
  organization_id: string | null
}

/**
 * The signed-in user and their profile. Cached per request, so the layout,
 * the page and every loader share one auth check and one profile query.
 */
export const getSession = cache(async () => {
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
})

/** Shorthand for canManageClient(profile.role) */
export function canManage(profile: Profile) {
  return canManageClient(profile.role)
}
