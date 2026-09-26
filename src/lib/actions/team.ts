'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { getSession } from '@/lib/auth/session'
import { canManageClient, isOrgAdmin } from '@/lib/auth/permissions'
import { SELECTED_CLIENT_COOKIE, SELECTED_CLIENT_COOKIE_OPTIONS } from '@/lib/auth/client-context'
import { appOrigin } from '@/lib/app-url'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  inviteSchema,
  type AcceptInviteStatus,
  type InviteInput,
  type PendingInvite,
  type TeamActionError,
  type TeamMember,
  type UserRole,
} from '@/lib/types/team'

const TEAM_PATH = '/[locale]/dashboard/team'

type TeamRow = {
  user_id: string
  full_name: string | null
  email: string
  user_role: UserRole
  client_id: string | null
  client_name: string | null
  member_role: UserRole | null
  joined_at: string
}

/** Invite links always open the Arabic invite page (it has a language switch) */
async function inviteLink(code: string) {
  return `${await appOrigin()}/ar/invite/${code}`
}

/**
 * People the caller may see (team_members() scopes it: org admins get the
 * organization, client admins the members of their clients), one entry per
 * person with the clients they belong to.
 */
export async function getTeamMembers(): Promise<TeamMember[]> {
  const { supabase, profile } = await getSession()
  if (!profile || !canManageClient(profile.role)) return []

  const { data, error } = await supabase.rpc('team_members')
  if (error) throw new Error(`Failed to load team: ${error.message}`)

  const members = new Map<string, TeamMember>()
  for (const row of (data as TeamRow[] | null) ?? []) {
    const member = members.get(row.user_id) ?? {
      id: row.user_id,
      full_name: row.full_name,
      email: row.email,
      role: row.user_role,
      joined_at: row.joined_at,
      clients: [],
    }
    if (row.client_id && row.client_name && !member.clients.some((c) => c.id === row.client_id)) {
      member.clients.push({ id: row.client_id, name: row.client_name, role: row.member_role })
    }
    if (row.joined_at < member.joined_at) member.joined_at = row.joined_at
    members.set(row.user_id, member)
  }
  return [...members.values()]
}

export async function getPendingInvites(): Promise<PendingInvite[]> {
  const { supabase, profile } = await getSession()
  if (!profile || !canManageClient(profile.role)) return []

  // RLS: org admins see their organization's invites, client admins their clients'
  const { data, error } = await supabase
    .from('organization_invites')
    .select('id, email, invited_name, role, invite_code, created_at, expires_at, client:clients(id, name)')
    .is('accepted_at', null)
    .order('created_at', { ascending: false })
    .returns<(Omit<PendingInvite, 'expired' | 'link'> & { invite_code: string })[]>()
  if (error) throw new Error(`Failed to load invites: ${error.message}`)

  const now = Date.now()
  return Promise.all(
    data.map(async ({ invite_code, ...invite }) => ({
      ...invite,
      expired: new Date(invite.expires_at).getTime() <= now,
      link: await inviteLink(invite_code),
    }))
  )
}

export async function createInvite(
  input: InviteInput
): Promise<{ ok: true; link: string } | { ok: false; error: TeamActionError; field?: string }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManageClient(profile.role) || !profile.organization_id) {
    return { ok: false, error: 'forbidden' }
  }

  const parsed = inviteSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'validation', field: String(parsed.error.issues[0]?.path[0] ?? '') }
  }
  const { email, name, role, clientId } = parsed.data

  // Already on this client's team?
  const team = await getTeamMembers()
  if (team.some((m) => m.email.toLowerCase() === email && m.clients.some((c) => c.id === clientId))) {
    return { ok: false, error: 'alreadyMember' }
  }

  const { data: pending } = await supabase
    .from('organization_invites')
    .select('id')
    .eq('email', email)
    .eq('client_id', clientId)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
  if (pending && pending.length > 0) return { ok: false, error: 'alreadyInvited' }

  // RLS: org admins may invite to any client of their org, client admins only
  // to their own clients, and only as client_admin / team_member
  const { data, error } = await supabase
    .from('organization_invites')
    .insert({
      organization_id: profile.organization_id,
      email,
      invited_name: name,
      role,
      client_id: clientId,
      invited_by: profile.id,
    })
    .select('invite_code')
    .single<{ invite_code: string }>()

  if (error) {
    if (error.code === '42501') return { ok: false, error: 'forbidden' }
    console.error('[team] createInvite', error)
    return { ok: false, error: 'unknown' }
  }

  revalidatePath(TEAM_PATH, 'page')
  return { ok: true, link: await inviteLink(data.invite_code) }
}

export async function cancelInvite(inviteId: string): Promise<{ ok: true } | { ok: false; error: TeamActionError }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManageClient(profile.role)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(inviteId)) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase
    .from('organization_invites')
    .delete()
    .eq('id', inviteId)
    .is('accepted_at', null)
    .select('id')
  if (error) {
    console.error('[team] cancelInvite', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(TEAM_PATH, 'page')
  return { ok: true }
}

/** Detaches someone from the organization (org admins only). */
export async function removeTeamMember(userId: string): Promise<{ ok: true } | { ok: false; error: TeamActionError }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!isOrgAdmin(profile.role)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(userId)) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase.rpc('remove_org_member', { member_id: userId })
  if (error) {
    console.error('[team] removeTeamMember', error)
    return { ok: false, error: 'unknown' }
  }
  const status = data as 'ok' | 'forbidden' | 'not_found' | 'self'
  if (status === 'forbidden') return { ok: false, error: 'forbidden' }
  if (status === 'not_found') return { ok: false, error: 'notFound' }
  if (status === 'self') return { ok: false, error: 'self' }

  revalidatePath(TEAM_PATH, 'page')
  return { ok: true }
}

/** Accepts an invite for the signed-in user and focuses the dashboard on its client. */
export async function acceptInvite(code: string): Promise<{ status: AcceptInviteStatus | 'unauthorized' }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { status: 'unauthorized' }
  if (typeof code !== 'string' || !/^[0-9a-f]{16,64}$/i.test(code)) return { status: 'not_found' }

  const { data: invite } = await supabase.rpc('get_invite', { code }).maybeSingle<{ client_id: string | null }>()
  const { data, error } = await supabase.rpc('accept_invite', { code })
  if (error) {
    console.error('[team] acceptInvite', error)
    return { status: 'not_found' }
  }

  const status = data as AcceptInviteStatus
  if (status === 'ok' && invite?.client_id) {
    const store = await cookies()
    store.set(SELECTED_CLIENT_COOKIE, invite.client_id, SELECTED_CLIENT_COOKIE_OPTIONS)
  }
  return { status }
}
