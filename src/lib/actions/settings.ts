'use server'

import { revalidatePath } from 'next/cache'
import { getSession, isImpersonating, type Profile } from '@/lib/auth/session'
import {
  displayNameSchema,
  organizationNameSchema,
  type AccountSettings,
  type OrganizationSettings,
  type SettingsActionResult,
} from '@/lib/types/settings'

/**
 * The organization section is for the organization's own admins. Checked
 * here, in every loader and action, not only where the page decides what to
 * render: a server action can be called directly.
 */
function managesOrganization(profile: Profile): profile is Profile & { organization_id: string } {
  return profile.role === 'org_admin' && profile.organization_id !== null
}

/** The signed-in user's own settings; the organization only for its admins. */
export async function getAccountSettings(): Promise<AccountSettings | null> {
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const { data: user, error } = await supabase
    .from('users')
    .select('full_name, email')
    .eq('id', profile.id)
    .maybeSingle<{ full_name: string | null; email: string }>()
  if (error) throw new Error(`Failed to load account settings: ${error.message}`)
  if (!user) return null

  let organization: OrganizationSettings | null = null
  if (managesOrganization(profile)) {
    const { data } = await supabase
      .from('organizations')
      .select('name, org_type')
      .eq('id', profile.organization_id)
      .maybeSingle<OrganizationSettings>()
    organization = data
  }

  return { full_name: user.full_name ?? '', email: user.email, organization }
}

/** Changes the caller's own display name. There is no user id to pass: it is always the session's. */
export async function updateDisplayName(name: string): Promise<SettingsActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }

  const parsed = displayNameSchema.safeParse(name)
  if (!parsed.success) return { ok: false, error: 'validation' }

  // Scoped to the caller's row explicitly: RLS alone would let an
  // organization admin's update reach every user of the organization
  const { data, error } = await supabase
    .from('users')
    .update({ full_name: parsed.data })
    .eq('id', profile.id)
    .select('id')
  if (error) {
    console.error('[settings] display name', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'unknown' }

  revalidatePath('/[locale]/dashboard', 'layout')
  return { ok: true }
}

/**
 * Renames the caller's own organization. Organization admins only; there is
 * no organization id to pass. The database function checks the same again.
 */
export async function updateOrganizationName(name: string): Promise<SettingsActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!managesOrganization(profile)) return { ok: false, error: 'forbidden' }

  const parsed = organizationNameSchema.safeParse(name)
  if (!parsed.success) return { ok: false, error: 'validation' }

  const { data, error } = await supabase.rpc('rename_my_organization', { p_name: parsed.data })
  if (error) {
    console.error('[settings] organization name', error)
    return { ok: false, error: 'unknown' }
  }
  if (data === 'forbidden') return { ok: false, error: 'forbidden' }
  if (data === 'invalid') return { ok: false, error: 'validation' }
  if (data !== 'ok') return { ok: false, error: 'unknown' }

  revalidatePath('/[locale]/dashboard', 'layout')
  return { ok: true }
}
