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
import { getOrganizationAiUsage } from '@/lib/actions/ai-usage'
import { getPlans } from '@/lib/actions/admin-plans'
import { getOrganizationBilling } from '@/lib/actions/admin-subscriptions'
import { getClientAvailablePlans, getClientInvoices, getClientSubscription } from '@/lib/actions/client-subscription'
import { InvoicesTable } from '@/components/billing/invoices-table'
import { UsageBars } from '@/components/billing/usage-bars'
import { CurrentPlanCard } from '@/components/billing/current-plan-card'
import { SubscriptionActions } from '../../_components/subscription-actions'
import { CreateInvoiceDialog } from '@/components/billing/create-invoice-dialog'
import type { ClientStatus } from '@/lib/types/clients'
import type { UserRole } from '@/lib/types/team'
import { ToggleOrgButton } from './_components/toggle-org-button'
import { ImpersonateButton } from '../../_components/impersonate-button'
import { ClientPlanPicker } from '@/components/billing/client-plan-picker'
import { ClientPricingActions } from '@/components/billing/client-pricing-actions'

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

export default async function AdminCustomerPage({ params }: PageProps<'/[locale]/admin/customers/[orgId]'>) {
  const { locale, orgId } = await params
  await requireSuperAdmin(locale)

  const [details, billing, plans, aiUsage] = await Promise.all([
    getOrganizationDetails(orgId),
    getOrganizationBilling(orgId),
    getPlans(),
    getOrganizationAiUsage(orgId),
  ])
  if (!details) notFound()

  const t = await getTranslations('admin.details')
  const tRoles = await getTranslations('team.roles')
  const tClients = await getTranslations('clients')
  const tBilling = await getTranslations('subscription.admin.orgSection')
  const format = await getFormatter()
  const tTypes = await getTranslations('admin.customers.type')
  const tAi = await getTranslations('aiUsage.orgClients')
  const { organization: org, stats, clients, users } = details
  const directClient = org.org_type === 'direct' ? clients[0] : undefined

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
        href="/admin/customers"
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
            <Badge variant={org.org_type === 'direct' ? 'secondary' : 'outline'}>{tTypes(org.org_type)}</Badge>
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
        <div className="flex flex-wrap gap-2">
          <ImpersonateButton organizationId={org.id} organizationName={org.name} size="default" />
          <ToggleOrgButton orgId={org.id} name={org.name} isActive={org.is_active} />
        </div>
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

      {org.org_type === 'direct' ? (
        directClient ? (
          <DirectBilling organizationId={org.id} clientId={directClient.id} clientName={directClient.name} />
        ) : (
          <p className="text-sm text-muted-foreground">{tBilling('none')}</p>
        )
      ) : billing?.details ? (
        <section className="grid gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-xl font-semibold tracking-tight">{tBilling('title')}</h2>
            <SubscriptionActions
              variant="buttons"
              plans={plans}
              target={{
                organizationId: org.id,
                organizationName: org.name,
                planId: billing.details.plan.id,
                status: billing.details.subscription.status,
                notes: billing.details.subscription.notes,
                hasCustomPricing: !!billing.details.custom_pricing,
                basePrice: billing.details.plan.price_monthly,
              }}
            />
          </div>
          <CurrentPlanCard details={billing.details} title={tBilling('plan')} />
          {billing.details.custom_pricing && !billing.details.custom_pricing.applies && (
            <p className="text-sm text-amber-700 dark:text-amber-400">{tBilling('pricingNotApplied')}</p>
          )}
          {billing.details.subscription.notes && (
            <p className="text-sm text-muted-foreground">{tBilling('notes', { notes: billing.details.subscription.notes })}</p>
          )}
          <Card>
            <CardHeader>
              <CardTitle>{tBilling('usage')}</CardTitle>
            </CardHeader>
            <CardContent>
              <UsageBars usage={billing.details.usage} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
              <div className="grid gap-1">
                <CardTitle>{tBilling('invoices')}</CardTitle>
                <CardDescription>{tBilling('invoicesCount', { count: billing.invoices.length })}</CardDescription>
              </div>
              <CreateInvoiceDialog parties={[]} partyId={org.id} />
            </CardHeader>
            <CardContent>
              <InvoicesTable invoices={billing.invoices} actions="platform" />
            </CardContent>
          </Card>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{tBilling('none')}</p>
      )}

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
                  <TableHead className="text-end">{tAi('tokens30')}</TableHead>
                  <TableHead className="text-end">{tAi('cost30')}</TableHead>
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
                    <TableCell className="text-end tabular-nums">{format.number(aiUsage[client.id]?.total_tokens ?? 0)}</TableCell>
                    <TableCell className="text-end tabular-nums" dir="ltr">
                      {format.number(aiUsage[client.id]?.cost_usd ?? 0, {
                        style: 'currency',
                        currency: 'USD',
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 4,
                      })}
                    </TableCell>
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

/**
 * A direct business has no organization subscription: its one client's
 * business plan is what it pays the platform for, managed here.
 */
async function DirectBilling({
  organizationId,
  clientId,
  clientName,
}: {
  organizationId: string
  clientId: string
  clientName: string
}) {
  const tBilling = await getTranslations('subscription.admin.orgSection')
  const [details, plans, invoices] = await Promise.all([
    getClientSubscription(clientId),
    getClientAvailablePlans(clientId),
    getClientInvoices(clientId),
  ])
  if (!details) return <p className="text-sm text-muted-foreground">{tBilling('none')}</p>
  const { plan, custom_pricing: custom } = details

  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">{tBilling('title')}</h2>
          <p className="text-sm text-muted-foreground">{tBilling('directNote')}</p>
        </div>
        <ClientPricingActions
          clientId={clientId}
          clientName={clientName}
          basePrice={plan.price_monthly}
          hasCustomPricing={!!custom}
        />
      </div>
      <CurrentPlanCard details={details} title={tBilling('plan')} />
      {custom && !custom.applies && <p className="text-sm text-amber-700 dark:text-amber-400">{tBilling('pricingNotApplied')}</p>}
      <Card>
        <CardHeader>
          <CardTitle>{tBilling('usage')}</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageBars usage={details.usage} />
        </CardContent>
      </Card>
      <ClientPlanPicker
        clientId={clientId}
        clientName={clientName}
        plans={plans}
        currentPlanId={plan.id}
        canChange
      />
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <CardTitle>{tBilling('invoices')}</CardTitle>
            <CardDescription>{tBilling('invoicesCount', { count: invoices.length })}</CardDescription>
          </div>
          {/* Billed to the organization; the database files it under its one client */}
          <CreateInvoiceDialog parties={[]} partyId={organizationId} />
        </CardHeader>
        <CardContent>
          <InvoicesTable invoices={invoices} actions="platform" />
        </CardContent>
      </Card>
    </section>
  )
}
