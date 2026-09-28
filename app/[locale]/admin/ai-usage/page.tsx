import { getTranslations } from 'next-intl/server'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getAiUsageOverview } from '@/lib/actions/ai-usage'
import { parseAnalyticsRange } from '@/lib/analytics-range'
import { AiUsageDashboard } from './_components/ai-usage-dashboard'

/**
 * What the AI costs the platform, per client and per operation, against
 * what each client's subscription brings in, for today / 7 / 30 days or a
 * custom period (Cairo dates).
 */
export default async function AdminAiUsagePage({ params, searchParams }: PageProps<'/[locale]/admin/ai-usage'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const range = parseAnalyticsRange(await searchParams)
  const [t, overview] = await Promise.all([
    getTranslations('aiUsage'),
    getAiUsageOverview({ from: range.from, to: range.to }),
  ])

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>
      {overview ? <AiUsageDashboard overview={overview} range={range} /> : <p className="text-muted-foreground">{t('unavailable')}</p>}
    </div>
  )
}
