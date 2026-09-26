/**
 * Role checks shared by server code and UI. users.role is global.
 *
 *  - super_admin / org_admin: the whole organization
 *  - client_admin: runs their client(s): channels, knowledge base, bot
 *    settings, playground, team invites
 *  - team_member: day-to-day work only: assigned conversations, leads,
 *    appointments and the overview
 *
 * The database enforces the same rules with RLS; these checks keep the UI
 * and server actions from offering or attempting what RLS would refuse.
 */

export const CLIENT_MANAGER_ROLES = ['super_admin', 'org_admin', 'client_admin'] as const
export const ORG_ADMIN_ROLES = ['super_admin', 'org_admin'] as const

/** Channels, knowledge base, bot settings, playground and team invites */
export function canManageClient(role: string | null | undefined): boolean {
  return (CLIENT_MANAGER_ROLES as readonly string[]).includes(role ?? '')
}

/** Organization-wide: every client, removing members */
export function isOrgAdmin(role: string | null | undefined): boolean {
  return (ORG_ADMIN_ROLES as readonly string[]).includes(role ?? '')
}
