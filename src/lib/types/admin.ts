import type { ClientStatus } from '@/lib/types/clients'
import type { UserRole } from '@/lib/types/team'

/** A platform total and how many were added in the last 30 days vs the 30 before. */
export type Growth = { total: number; last30: number; prev30: number }

export type PlatformStats = {
  organizations: Growth & { active: number }
  clients: Growth
  users: Growth
  conversations: Growth
  leads: Growth
}

export const ORG_TYPES = ['agency', 'direct'] as const
export type OrgType = (typeof ORG_TYPES)[number]

export type OrganizationOverview = {
  id: string
  name: string
  slug: string
  orgType: OrgType
  isActive: boolean
  createdAt: string
  clients: number
  users: number
  conversations: number
  leads: number
  lastActivityAt: string | null
}

export const ORG_SORT_KEYS = ['name', 'clients', 'users', 'conversations', 'leads', 'createdAt', 'lastActivityAt'] as const
export type OrgSortKey = (typeof ORG_SORT_KEYS)[number]
export type SortDir = 'asc' | 'desc'
export type OrgSort = { key: OrgSortKey; dir: SortDir }

export const DEFAULT_ORG_SORT: OrgSort = { key: 'createdAt', dir: 'desc' }

export const ORG_STATUS_FILTERS = ['active', 'disabled'] as const
export type OrgStatusFilter = (typeof ORG_STATUS_FILTERS)[number]

export type AdminOrganization = {
  id: string
  name: string
  slug: string
  logo_url: string | null
  is_active: boolean
  created_at: string
  updated_at: string
  org_type: OrgType
}

export type AdminOrgStats = {
  clients: number
  active_clients: number
  users: number
  channels: number
  conversations: number
  conversations_last_30: number
  leads: number
  leads_last_30: number
  booked: number
  last_activity_at: string | null
}

export type AdminOrgClient = {
  id: string
  name: string
  slug: string
  industry: string | null
  status: ClientStatus
  created_at: string
  channels: number
  conversations: number
  leads: number
  last_activity_at: string | null
}

export type AdminOrgUser = {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  created_at: string
  last_sign_in_at: string | null
  clients: { id: string; name: string; role: UserRole }[]
}

export type OrganizationDetails = {
  organization: AdminOrganization
  stats: AdminOrgStats
  clients: AdminOrgClient[]
  users: AdminOrgUser[]
}

export type SuperAdmin = { id: string; email: string; full_name: string | null; created_at: string }

export type ToggleOrganizationResult =
  | { ok: true; isActive: boolean }
  | { ok: false; error: 'forbidden' | 'notFound' | 'failed' }
