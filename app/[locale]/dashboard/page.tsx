import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { MessagesSquare, Users, Building2, TrendingUp } from 'lucide-react'
import { getTranslations } from 'next-intl/server'

export default async function DashboardPage() {
  const t = await getTranslations('dashboard')

  const stats = [
    { name: t('totalConversations'), value: '0', icon: MessagesSquare, change: '+0%' },
    { name: t('activeLeads'), value: '0', icon: Users, change: '+0%' },
    { name: t('clients'), value: '0', icon: Building2, change: '+0%' },
    { name: t('conversionRate'), value: '0%', icon: TrendingUp, change: '+0%' },
  ]

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">{t('overview')}</h1>
        <p className="text-muted-foreground mt-1">{t('welcomeBack')}</p>
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
              <p className="text-xs text-muted-foreground mt-1">
                {stat.change} {t('fromLastMonth')}
              </p>
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
          <div className="text-center py-12 text-muted-foreground text-sm">
            {t('noActivity')}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}