import type { OrgType } from '@/lib/auth/client-context'

export type ImpersonationResult = { ok: true } | { ok: false; error: 'forbidden' | 'notFound' | 'unknown' }

/** One row of get_impersonation_log (ended_at is null while the session is open) */
export type ImpersonationLogEntry = {
  id: string
  admin_name: string | null
  admin_email: string
  organization_id: string
  organization_name: string
  org_type: OrgType
  started_at: string
  ended_at: string | null
  actions_count: number
}
