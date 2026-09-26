import { getTranslations } from 'next-intl/server'
import { getClientContext } from '@/lib/auth/client-context'
import { getPendingInvites, getTeamMembers } from '@/lib/actions/team'
import { requireClientManager } from '@/lib/auth/guards'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { InviteDialog } from './_components/invite-dialog'
import { MembersTable } from './_components/members-table'
import { InvitesList } from './_components/invites-list'

export default async function TeamPage({ params }: PageProps<'/[locale]/dashboard/team'>) {
  const { locale } = await params
  // Team members can't see or manage the team
  await requireClientManager(locale)
  const context = await getClientContext()
  if (!context) return null

  const t = await getTranslations('team')
  const [members, invites] = await Promise.all([getTeamMembers(), getPendingInvites()])

  // With a client picked in the switcher, show that client's people (org
  // admins can access every client, so they're always listed)
  const selected = context.selected
  const visibleMembers = selected
    ? members.filter(
        (m) => isOrgAdmin(m.role) || m.clients.some((c) => c.id === selected.id)
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
        <InviteDialog
          clients={context.clients}
          // A client picked in the switcher (always the case for client
          // admins) is where the invite goes; "all clients" lets them choose
          lockedClient={selected}
        />
      </div>

      <div className="grid gap-6">
        <MembersTable
          members={visibleMembers}
          currentUserId={context.profile.id}
          canRemove={isOrgAdmin(context.profile.role)}
        />
        <InvitesList invites={visibleInvites} />
      </div>
    </div>
  )
}
