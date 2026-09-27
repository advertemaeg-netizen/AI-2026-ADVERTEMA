import 'server-only'
import { cache } from 'react'
import { cookies } from 'next/headers'
import { getSession } from '@/lib/auth/session'

export const SELECTED_CLIENT_COOKIE = 'selected_client_id'

export const SELECTED_CLIENT_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 60 * 60 * 24 * 365,
} as const

const ORG_LEVEL_ROLES = ['super_admin', 'org_admin']

export type ClientOption = { id: string; name: string }

/** agency: many clients · direct: a single business (exactly one client) */
export type OrgType = 'agency' | 'direct'

/**
 * Which client the dashboard is scoped to, for this request.
 *  - direct business: always its one client (no switcher, no "all clients")
 *  - super/org admins: the client picked in the switcher, or null = all clients
 *  - client admins / team members: always one of their own clients (the
 *    picked one if they belong to several, else the first)
 * `clients` is what the user may switch between (RLS-scoped).
 * Cached per request, so the layout and the page share one lookup.
 */
export const getClientContext = cache(async () => {
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const [{ data }, { data: organization }] = await Promise.all([
    supabase.from('clients').select('id, name').order('name').returns<ClientOption[]>(),
    profile.organization_id
      ? supabase
          .from('organizations')
          .select('org_type')
          .eq('id', profile.organization_id)
          .maybeSingle<{ org_type: OrgType }>()
      : Promise.resolve({ data: null }),
  ])
  const clients = data ?? []
  const orgType: OrgType = organization?.org_type === 'direct' ? 'direct' : 'agency'

  if (orgType === 'direct') {
    return { profile, clients, selected: clients[0] ?? null, canSeeAll: false, orgType }
  }

  const canSeeAll = ORG_LEVEL_ROLES.includes(profile.role)
  const picked = (await cookies()).get(SELECTED_CLIENT_COOKIE)?.value
  const selected =
    clients.find((client) => client.id === picked) ?? (canSeeAll ? null : (clients[0] ?? null))

  return { profile, clients, selected, canSeeAll, orgType }
})

/** The client the dashboard is scoped to, or null for "all clients". */
export async function getSelectedClient(): Promise<ClientOption | null> {
  return (await getClientContext())?.selected ?? null
}
