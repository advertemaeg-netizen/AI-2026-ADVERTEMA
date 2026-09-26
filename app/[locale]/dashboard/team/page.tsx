import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getClientContext } from '@/lib/auth/client-context'
import { getPendingInvites, getTeamMembers } from '@/lib/actions/team'
import { ORG_ADMIN_ROLES, TEAM_MANAGER_ROLES } from '@/lib/types/team'
import { InviteDialog } from './_components/invite-dialog'
import { MembersTable } from './_components/members-table'
import { InvitesList } from './_components/invites-list'

export default async function TeamPage() {
  const context = await getClientContext()
  if (!context || !TEAM_MANAGER_ROLES.includes(context.profile.role)) notFound()

  const t = await getTranslations('team')
  const [members, invites] = await Promise.all([getTeamMembers(), getPendingInvites()])

  // With a client picked in the switcher, show that client's people (org
  // admins can access every client, so they're always listed)
  const selected = context.selected
  const visibleMembers = selected
    ? members.filter(
        (m) => ORG_ADMIN_ROLES.includes(m.role) || m.clients.some((c) => c.id === selected.id)
      )
    : members
  const visibleInvites = selected ? invites.filter((i) => i.client?.id === selected.id) : invites

  return (
    <div className="p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">
            {selected ? t('descriptionScoped', { client: selected.name }) : t('description')}
          </p>
        </div>
        <InviteDialog clients={context.clients} defaultClientId={selected?.id ?? null} />
      </div>

      <div className="grid gap-6">
        <MembersTable
          members={visibleMembers}
          currentUserId={context.profile.id}
          canRemove={ORG_ADMIN_ROLES.includes(context.profile.role)}
        />
        <InvitesList invites={visibleInvites} />
      </div>
    </div>
  )
}
