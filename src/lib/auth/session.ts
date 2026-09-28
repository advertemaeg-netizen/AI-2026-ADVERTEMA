import 'server-only'
import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { canManageClient, isSuperAdmin } from '@/lib/auth/permissions'
import { resolveImpersonation, type Impersonation } from '@/lib/auth/impersonation'

export type Profile = {
  id: string
  role: string
  organization_id: string | null
}

/**
 * The signed-in user and their profile. Cached per request, so the layout,
 * the page and every loader share one auth check and one profile query.
 *
 * A super admin viewing a customer's account gets that organization's
 * admin profile (the database sees them the same way) and `impersonation`
 * is set: server actions that change data refuse while it is.
 */
export const getSession = cache(async () => {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { supabase, profile: null, impersonation: null }

  const { data: profile } = await supabase
    .from('users')
    .select('id, role, organization_id')
    .eq('id', user.id)
    .single<Profile>()

  if (!profile || !isSuperAdmin(profile.role)) return { supabase, profile, impersonation: null }

  const impersonation: Impersonation | null = await resolveImpersonation(supabase, profile.id)
  if (!impersonation) return { supabase, profile, impersonation: null }

  return {
    supabase,
    profile: { ...profile, role: 'org_admin', organization_id: impersonation.organizationId },
    impersonation,
  }
})

/** Shorthand for canManageClient(profile.role) */
export function canManage(profile: Profile) {
  return canManageClient(profile.role)
}

/**
 * Whether a super admin is viewing a customer's account: server actions
 * that change data refuse ('impersonating'), except the support tools.
 */
export async function isImpersonating() {
  return (await getSession()).impersonation !== null
}
