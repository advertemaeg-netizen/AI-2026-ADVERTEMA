import { z } from 'zod'
import { UUID_PATTERN } from './clients'

export const INVITABLE_ROLES = ['client_admin', 'team_member'] as const
export type InvitableRole = (typeof INVITABLE_ROLES)[number]

/** Roles that can open the team page and invite people */
export const TEAM_MANAGER_ROLES = ['super_admin', 'org_admin', 'client_admin']
/** Roles that can remove people from the organization */
export const ORG_ADMIN_ROLES = ['super_admin', 'org_admin']

export type UserRole = 'super_admin' | 'org_admin' | 'client_admin' | 'team_member'

export type TeamMember = {
  id: string
  full_name: string | null
  email: string
  role: UserRole
  joined_at: string
  clients: { id: string; name: string; role: UserRole | null }[]
}

export type PendingInvite = {
  id: string
  email: string
  invited_name: string | null
  role: UserRole
  created_at: string
  expires_at: string
  expired: boolean
  link: string
  client: { id: string; name: string } | null
}

export const inviteSchema = z.object({
  email: z.email('invalidEmail').trim().toLowerCase().max(254),
  name: z
    .string()
    .trim()
    .max(120, 'tooLong')
    .transform((v) => v || null),
  role: z.enum(INVITABLE_ROLES),
  clientId: z.string().regex(UUID_PATTERN, 'clientRequired'),
})

export type InviteInput = z.input<typeof inviteSchema>

export type TeamActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'notFound'
  | 'alreadyInvited'
  | 'alreadyMember'
  | 'self'
  | 'unknown'

export type AcceptInviteStatus =
  | 'ok'
  | 'not_found'
  | 'expired'
  | 'already_accepted'
  | 'email_mismatch'
  | 'other_organization'
