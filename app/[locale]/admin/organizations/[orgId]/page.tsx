import { notFound } from 'next/navigation'
import { getFormatter, getTranslations } from 'next-intl/server'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RelativeTime } from '@/components/relative-time'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getOrganizationDetails } from '@/lib/actions/admin'
import type { ClientStatus } from '@/lib/types/clients'
import type { UserRole } from '@/lib/types/team'
import { ToggleOrgButton } from './_components/toggle-org-button'

const CLIENT_STATUS_VARIANT: Record<ClientStatus, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  paused: 'secondary',
  archived: 'outline',
}

const ROLE_VARIANT: Record<UserRole, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  super_admin: 'destructive',
  org_admin: 'default',
  client_admin: 'secondary',
  team_member: 'outline',
}

export default async function AdminOrganizationPage({ params }: PageProps<'/[locale]/admin/organizations/[orgId]'>) {
  const { locale, orgId } = await params
  await requireSuperAdmin(locale)

  const details = await getOrganizationDetails(orgId)
  if (!details) notFound()

  const t = await getTranslations('admin.details')
  const tRoles = await getTranslations('team.roles')
  const tClients = await getTranslations('clients')
  const format = await getFormatter()
  const { organization: org, stats, clients, users } = details

  const statCards = [
    { label: t('stats.clients'), value: stats.clients, hint: t('stats.activeClients', { count: stats.active_clients }) },
    { label: t('stats.users'), value: stats.users },
    { label: t('stats.channels'), value: stats.channels },
    { label: t('stats.conversations'), value: stats.conversations, hint: t('stats.last30', { count: stats.conversations_last_30 }) },
    { label: t('stats.leads'), value: stats.leads, hint: t('stats.last30', { count: stats.leads_last_30 }) },
    { label: t('stats.booked'), value: stats.booked },
  ]

  return (
    <div className="p-8 grid gap-6">
      <Link
        href="/admin/organizations"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" />
        {t('back')}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{org.name}</h1>
            <Badge variant={org.is_active ? 'default' : 'destructive'}>
              {t(org.is_active ? 'active' : 'disabled')}
            </Badge>
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
            <div className="flex gap-1">
              <dt>{t('slug')}:</dt>
              <dd dir="ltr">{org.slug}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{t('createdAt')}:</dt>
              <dd>{format.dateTime(new Date(org.created_at), { dateStyle: 'medium' })}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{t('lastActivity')}:</dt>
              <dd>{stats.last_activity_at ? <RelativeTime date={stats.last_activity_at} /> : t('noActivity')}</dd>
            </div>
          </dl>
        </div>
        <ToggleOrgButton orgId={org.id} name={org.name} isActive={org.is_active} />
      </div>

      {!org.is_active && (
        <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <p>{t('disabledNotice')}</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {statCards.map((card) => (
          <Card key={card.label} size="sm">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{card.label}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1">
              <div className="text-2xl font-semibold">{format.number(card.value)}</div>
              {card.hint && <p className="text-xs text-muted-foreground">{card.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('clients.title')}</CardTitle>
          <CardDescription>{t('clients.count', { count: clients.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          {clients.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('clients.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('clients.name')}</TableHead>
                  <TableHead>{t('clients.industry')}</TableHead>
                  <TableHead>{t('clients.status')}</TableHead>
                  <TableHead className="text-end">{t('clients.channels')}</TableHead>
                  <TableHead className="text-end">{t('clients.conversations')}</TableHead>
                  <TableHead className="text-end">{t('clients.leads')}</TableHead>
                  <TableHead>{t('clients.createdAt')}</TableHead>
                  <TableHead>{t('clients.lastActivity')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((client) => (
                  <TableRow key={client.id}>
                    <TableCell>
                      <div className="font-medium">{client.name}</div>
                      <div className="text-xs text-muted-foreground" dir="ltr">
                        {client.slug}
                      </div>
                    </TableCell>
                    <TableCell>{client.industry || '—'}</TableCell>
                    <TableCell>
                      <Badge variant={CLIENT_STATUS_VARIANT[client.status]}>{tClients(`status.${client.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{format.number(client.channels)}</TableCell>
                    <TableCell className="text-end tabular-nums">{format.number(client.conversations)}</TableCell>
                    <TableCell className="text-end tabular-nums">{format.number(client.leads)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {format.dateTime(new Date(client.created_at), { dateStyle: 'medium' })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {client.last_activity_at ? <RelativeTime date={client.last_activity_at} /> : t('noActivity')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('users.title')}</CardTitle>
          <CardDescription>{t('users.count', { count: users.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          {users.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('users.empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('users.name')}</TableHead>
                  <TableHead>{t('users.role')}</TableHead>
                  <TableHead>{t('users.clients')}</TableHead>
                  <TableHead>{t('users.joined')}</TableHead>
                  <TableHead>{t('users.lastSignIn')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell>
                      <div className="font-medium">{user.full_name || '—'}</div>
                      <div className="text-xs text-muted-foreground" dir="ltr">
                        {user.email}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={ROLE_VARIANT[user.role]}>{tRoles(user.role)}</Badge>
                    </TableCell>
                    <TableCell className="max-w-72 whitespace-normal">
                      {user.role === 'org_admin' || user.role === 'super_admin' ? (
                        <span className="text-muted-foreground">{t('users.allClients')}</span>
                      ) : user.clients.length === 0 ? (
                        '—'
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {user.clients.map((client) => (
                            <Badge key={client.id} variant="outline">
                              {client.name}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {format.dateTime(new Date(user.created_at), { dateStyle: 'medium' })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {user.last_sign_in_at ? <RelativeTime date={user.last_sign_in_at} /> : t('users.never')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
