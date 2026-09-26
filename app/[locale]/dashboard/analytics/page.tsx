import { getTranslations } from 'next-intl/server'
import { getAnalytics } from '@/lib/actions/analytics'
import { getClientContext } from '@/lib/auth/client-context'
import { parseAnalyticsRange } from '@/lib/analytics-range'
import { AnalyticsDashboard } from './_components/analytics-dashboard'

export default async function AnalyticsPage({ searchParams }: PageProps<'/[locale]/dashboard/analytics'>) {
  const t = await getTranslations('analytics')
  const range = parseAnalyticsRange(await searchParams)
  // Scoped to the client picked in the sidebar switcher (all clients if none);
  // RLS limits what each role sees
  const context = await getClientContext()
  const clientId = context?.selected?.id ?? null
  const data = await getAnalytics(clientId, range)

  return (
    <div className="p-8 print:p-0">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 print:hidden">{t('description')}</p>
      </div>

      {data ? (
        <AnalyticsDashboard
          data={data}
          clientId={clientId}
          scopeName={context?.selected?.name ?? t('allClients')}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('errors.load')}</p>
      )}
    </div>
  )
}
