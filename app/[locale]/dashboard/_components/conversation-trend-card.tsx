'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { BarChart3 } from 'lucide-react'
import { Bar, BarChart, XAxis } from 'recharts'
import { Link } from '@/i18n/navigation'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'

/** Conversations per day for the last 7 days, linking to the full analytics. */
export function ConversationTrendCard({ data }: { data: { date: string; conversations: number }[] }) {
  const t = useTranslations('analytics.trend')
  const tAnalytics = useTranslations('analytics')
  const format = useFormatter()
  const rtl = useLocale() === 'ar'
  const total = data.reduce((sum, d) => sum + d.conversations, 0)
  const config = { conversations: { label: tAnalytics('series.conversations'), color: 'var(--chart-1)' } } satisfies ChartConfig
  const day = (date: string) => format.dateTime(new Date(`${date}T12:00:00Z`), { weekday: 'short' })

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('total', { count: total })}</CardDescription>
        <CardAction>
          <Link
            href="/dashboard/analytics"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <BarChart3 className="size-4" />
            {t('viewAll')}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <ChartContainer config={config} className="aspect-auto h-36 w-full">
            <BarChart data={data} margin={{ top: 4, left: 4, right: 4 }} accessibilityLayer>
              <XAxis dataKey="date" reversed={rtl} tickLine={false} axisLine={false} tickMargin={6} tickFormatter={day} />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: 'medium' })}
                  />
                }
              />
              <Bar isAnimationActive={false} dataKey="conversations" fill="var(--color-conversations)" maxBarSize={24} radius={[4, 4, 0, 0]} />
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  )
}
