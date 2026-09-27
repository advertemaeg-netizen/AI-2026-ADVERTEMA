'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { isSuperAdmin } from '@/lib/auth/permissions'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  DEFAULT_ORG_SORT,
  ORG_SORT_KEYS,
  type Growth,
  type OrganizationDetails,
  type OrganizationOverview,
  type OrgSort,
  type PlatformStats,
  type SuperAdmin,
  type ToggleOrganizationResult,
} from '@/lib/types/admin'

// Postgres bigint can arrive as strings
const int = (value: unknown) => Number(value ?? 0)

/** The caller's Supabase client, or null unless they're a super admin. */
async function superAdminSession() {
  const { supabase, profile } = await getSession()
  if (!profile || !isSuperAdmin(profile.role)) return null
  return supabase
}

/** Platform totals with 30-day growth (the platform_stats view). */
export async function getPlatformStats(): Promise<PlatformStats | null> {
  const supabase = await superAdminSession()
  if (!supabase) return null

  const { data, error } = await supabase.from('platform_stats').select('*').maybeSingle<Record<string, unknown>>()
  if (error) throw new Error(`Failed to load platform stats: ${error.message}`)
  if (!data) return null

  const growth = (key: string): Growth => ({
    total: int(data[key]),
    last30: int(data[`${key}_last_30`]),
    prev30: int(data[`${key}_prev_30`]),
  })

  return {
    organizations: { ...growth('organizations'), active: int(data.active_organizations) },
    clients: growth('clients'),
    users: growth('users'),
    conversations: growth('conversations'),
    leads: growth('leads'),
  }
}

type OverviewRow = {
  id: string
  name: string
  slug: string
  is_active: boolean
  created_at: string
  clients: unknown
  users: unknown
  conversations: unknown
  leads: unknown
  last_activity_at: string | null
}

/** Every organization with its totals, filtered by name/slug and sorted. */
export async function getOrganizations(
  search?: string,
  sort: OrgSort = DEFAULT_ORG_SORT
): Promise<OrganizationOverview[]> {
  const supabase = await superAdminSession()
  if (!supabase) return []

  const { data, error } = await supabase.rpc('get_organizations_overview')
  if (error) throw new Error(`Failed to load organizations: ${error.message}`)

  const term = search?.trim().toLowerCase()
  const rows = ((data as OverviewRow[] | null) ?? [])
    .map(
      (row): OrganizationOverview => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        isActive: row.is_active,
        createdAt: row.created_at,
        clients: int(row.clients),
        users: int(row.users),
        conversations: int(row.conversations),
        leads: int(row.leads),
        lastActivityAt: row.last_activity_at,
      })
    )
    .filter((org) => !term || org.name.toLowerCase().includes(term) || org.slug.toLowerCase().includes(term))

  const key = (ORG_SORT_KEYS as readonly string[]).includes(sort.key) ? sort.key : DEFAULT_ORG_SORT.key
  const sign = sort.dir === 'asc' ? 1 : -1
  return rows.sort((a, b) => {
    const x = a[key]
    const y = b[key]
    // Organizations without activity always go last
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign
    if (key === 'name') return String(x).localeCompare(String(y)) * sign
    return (Date.parse(String(x)) - Date.parse(String(y))) * sign
  })
}

/** One organization: details, stats, clients and members. null if not found. */
export async function getOrganizationDetails(orgId: string): Promise<OrganizationDetails | null> {
  if (!UUID_PATTERN.test(orgId)) return null
  const supabase = await superAdminSession()
  if (!supabase) return null

  const { data, error } = await supabase.rpc('get_organization_details', { p_org_id: orgId })
  if (error) throw new Error(`Failed to load organization: ${error.message}`)
  if (!data) return null

  const details = data as OrganizationDetails
  const stats = Object.fromEntries(
    Object.entries(details.stats).map(([k, v]) => [k, k === 'last_activity_at' ? v : int(v)])
  ) as OrganizationDetails['stats']
  return { ...details, stats }
}

/** Soft-disables an organization (its members can't sign in), or re-enables it. */
export async function toggleOrganizationActive(orgId: string): Promise<ToggleOrganizationResult> {
  if (!UUID_PATTERN.test(orgId)) return { ok: false, error: 'notFound' }
  const supabase = await superAdminSession()
  if (!supabase) return { ok: false, error: 'forbidden' }

  const { data: org, error: readError } = await supabase
    .from('organizations')
    .select('is_active')
    .eq('id', orgId)
    .maybeSingle<{ is_active: boolean }>()
  if (readError) return { ok: false, error: 'failed' }
  if (!org) return { ok: false, error: 'notFound' }

  const isActive = !org.is_active
  const { data: updated, error } = await supabase
    .from('organizations')
    .update({ is_active: isActive })
    .eq('id', orgId)
    .select('id')
  if (error) return { ok: false, error: 'failed' }
  if (!updated?.length) return { ok: false, error: 'forbidden' }

  revalidatePath('/[locale]/admin', 'layout')
  return { ok: true, isActive }
}

/** Everyone with the super admin role (for the settings page). */
export async function getSuperAdmins(): Promise<SuperAdmin[]> {
  const supabase = await superAdminSession()
  if (!supabase) return []

  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name, created_at')
    .eq('role', 'super_admin')
    .order('created_at')
    .returns<SuperAdmin[]>()
  if (error) throw new Error(`Failed to load super admins: ${error.message}`)
  return data ?? []
}
