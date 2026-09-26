import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { MessagesSquare, Users, Building2, TrendingUp, Radio } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { RelativeTime } from '@/components/relative-time'
import { getDashboardStats } from '@/lib/dashboard-stats'
import { getSelectedClient } from '@/lib/auth/client-context'
import { LeadStatusBadge } from './leads/_components/lead-status-badge'

export default async function DashboardPage() {
  const t = await getTranslations('dashboard')
  const tConversations = await getTranslations('conversations')
  const format = await getFormatter()
  const selectedClient = await getSelectedClient()
  const data = await getDashboardStats(selectedClient?.id ?? null)
  if (!data) return null

  const percentChange = (value: number, previous: number | null) => {
    if (!previous) return t('noComparison')
    const change = (value - previous) / previous
    return t('vsPrevious', {
      change: `${change >= 0 ? '+' : ''}${format.number(change, { style: 'percent', maximumFractionDigits: 0 })}`,
    })
  }

  const conversionPoints =
    data.conversionRate.previous === null
      ? t('noComparison')
      : t('pointsChange', {
          change: `${data.conversionRate.value >= data.conversionRate.previous ? '+' : ''}${format.number(
            (data.conversionRate.value - data.conversionRate.previous) * 100,
            { maximumFractionDigits: 1 }
          )}`,
        })

  const stats = [
    {
      name: t('totalConversations'),
      value: format.number(data.conversations.value),
      icon: MessagesSquare,
      hint: percentChange(data.conversations.value, data.conversations.previous),
    },
    {
      name: t('activeLeads'),
      value: format.number(data.activeLeads.value),
      icon: Users,
      hint: t('newLeads', { count: data.activeLeads.newThisPeriod }),
    },
    data.scope.kind === 'channels'
      ? {
          name: t('activeChannels'),
          value: format.number(data.scope.value),
          icon: Radio,
          hint: t('activeChannelsHint'),
        }
      : {
          name: t('clients'),
          value: format.number(data.scope.value),
          icon: Building2,
          hint: t('clientsHint'),
        },
    {
      name: t('conversionRate'),
      value: format.number(data.conversionRate.value, { style: 'percent', maximumFractionDigits: 1 }),
      icon: TrendingUp,
      hint: conversionPoints,
    },
  ]

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">{t('overview')}</h1>
        <p className="text-muted-foreground mt-1">
          {selectedClient ? t('scopedTo', { client: selectedClient.name }) : t('welcomeBack')}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {stats.map((stat) => (
          <Card key={stat.name}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.name}
              </CardTitle>
              <stat.icon className="w-4 h-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stat.value}</div>
              <p className="text-xs text-muted-foreground mt-1">{stat.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('recentActivity')}</CardTitle>
          <CardDescription>{t('recentActivityDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.recent.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">{t('noActivity')}</div>
          ) : (
            <ul className="divide-y">
              {data.recent.map((item) => (
                <li key={`${item.kind}:${item.id}`}>
                  <Link
                    href={item.kind === 'lead' ? `/dashboard/leads/${item.id}` : `/dashboard/conversations/${item.id}`}
                    className="flex items-center gap-3 py-3 hover:bg-muted/50 -mx-2 px-2 rounded-md"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                      {item.kind === 'lead' ? <Users className="size-4" /> : <MessagesSquare className="size-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.kind === 'lead'
                          ? t('recent.lead', { name: item.title || t('recent.unnamed') })
                          : t('recent.conversation', {
                              name:
                                item.title ||
                                tConversations('visitor', {
                                  id: (item.identifier ?? '').slice(0, 6).toUpperCase() || '—',
                                }),
                            })}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">{item.client}</p>
                    </div>
                    {item.kind === 'lead' && <LeadStatusBadge status={item.status} />}
                    <RelativeTime date={item.at} className="shrink-0 text-xs text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
