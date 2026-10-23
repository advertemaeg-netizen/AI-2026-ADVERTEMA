import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StatPanel, type Stat } from './_components/stat-panel'
import { MessagesSquare, Users, Building2, TrendingUp, Radio } from 'lucide-react'
import { getFormatter, getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { RelativeTime } from '@/components/relative-time'
import { getDashboardStats } from '@/lib/dashboard-stats'
import { getSelectedClient } from '@/lib/auth/client-context'
import { LeadStatusBadge } from './leads/_components/lead-status-badge'
import { getJourneyStats, getUpcomingAppointments } from '@/lib/actions/appointments'
import { AttendanceCard, JourneyFunnel, TodayAppointmentsCard } from './_components/journey-widgets'
import { ConversationTrendCard } from './_components/conversation-trend-card'
import { getConversationTrend } from '@/lib/actions/analytics'

export default async function DashboardPage() {
  const t = await getTranslations('dashboard')
  const tConversations = await getTranslations('conversations')
  const format = await getFormatter()
  const selectedClient = await getSelectedClient()
  const clientId = selectedClient?.id ?? null
  const [data, todayAppointments, journey, trend] = await Promise.all([
    getDashboardStats(clientId),
    getUpcomingAppointments({ range: 'today', clientId }),
    getJourneyStats(clientId, '30d'),
    getConversationTrend(clientId, 7),
  ])
  if (!data || !journey) return null

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

  const stats: Stat[] = [
    {
      name: t('totalConversations'),
      value: data.conversations.value,
      icon: <MessagesSquare />,
      hint: percentChange(data.conversations.value, data.conversations.previous),
    },
    {
      name: t('activeLeads'),
      value: data.activeLeads.value,
      icon: <Users />,
      hint: t('newLeads', { count: data.activeLeads.newThisPeriod }),
    },
    data.scope.kind === 'channels'
      ? {
          name: t('activeChannels'),
          value: data.scope.value,
          icon: <Radio />,
          hint: t('activeChannelsHint'),
        }
      : {
          name: t('clients'),
          value: data.scope.value,
          icon: <Building2 />,
          hint: t('clientsHint'),
        },
    {
      name: t('conversionRate'),
      value: data.conversionRate.value,
      options: { style: 'percent', maximumFractionDigits: 1 },
      icon: <TrendingUp />,
      hint: conversionPoints,
    },
  ]

  return (
    <div className="page animate-enter">
      <div className="mb-8 max-md:mb-4">
        <h1 className="page-title">{t('overview')}</h1>
        <p className="text-muted-foreground mt-1">
          {selectedClient ? t('scopedTo', { client: selectedClient.name }) : t('welcomeBack')}
        </p>
      </div>

      <StatPanel stats={stats} />

      {/* The cards lift on hover; the wrapper carries the bloom so the card's own overflow does not clip it */}
      <div className="lift mb-8 rounded-xl max-md:mb-4">
        <ConversationTrendCard data={trend} />
      </div>

      <div className="mb-8 grid gap-4 lg:grid-cols-3 max-md:mb-4">
        <div className="lift rounded-xl *:h-full">
          <TodayAppointmentsCard appointments={todayAppointments} />
        </div>
        <div className="lift rounded-xl *:h-full">
          <AttendanceCard current={journey.current} previous={journey.previous} />
        </div>
        <div className="lift rounded-xl *:h-full">
          <JourneyFunnel conversations={data.conversations.value} stats={journey.current} />
        </div>
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
                    className="lift-row flex items-center gap-3 py-3 -mx-2 px-2 rounded-md"
                  >
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
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
                    {item.kind === 'lead' && <LeadStatusBadge status={item.status} visit={item.visit} />}
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
