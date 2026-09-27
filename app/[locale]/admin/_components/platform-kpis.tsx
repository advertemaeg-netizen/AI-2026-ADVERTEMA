import { getFormatter, getTranslations } from 'next-intl/server'
import { ArrowDownRight, ArrowUpRight, Building2, MessagesSquare, Minus, Users, UsersRound, UserRoundCheck, type LucideIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Growth, PlatformStats } from '@/lib/types/admin'

const ORDER: { key: keyof PlatformStats; icon: LucideIcon }[] = [
  { key: 'organizations', icon: Building2 },
  { key: 'clients', icon: UserRoundCheck },
  { key: 'users', icon: UsersRound },
  { key: 'conversations', icon: MessagesSquare },
  { key: 'leads', icon: Users },
]

/** Platform totals, each with what was added in the last 30 days vs the 30 before. */
export async function PlatformKpis({ stats }: { stats: PlatformStats }) {
  const t = await getTranslations('admin.kpis')
  const format = await getFormatter()

  function growth({ last30, prev30 }: Growth) {
    if (prev30 === 0) return { change: last30 > 0 ? 1 : 0, text: last30 > 0 ? t('growthNew') : t('growthNone') }
    const change = (last30 - prev30) / prev30
    const value = format.number(Math.abs(change), { style: 'percent', maximumFractionDigits: 0 })
    if (Math.abs(change) < 0.005) return { change: 0, text: t('growthSame') }
    return { change, text: t(change > 0 ? 'growthUp' : 'growthDown', { value }) }
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      {ORDER.map(({ key, icon: Icon }) => {
        const item = stats[key]
        const g = growth(item)
        const Trend = g.change > 0 ? ArrowUpRight : g.change < 0 ? ArrowDownRight : Minus
        return (
          <Card key={key} size="sm">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t(key)}</CardTitle>
              <Icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent className="grid gap-1">
              <div className="text-2xl font-semibold">{format.number(item.total)}</div>
              <p className="text-xs text-muted-foreground">
                {key === 'organizations'
                  ? t('activeOf', { active: format.number(stats.organizations.active) })
                  : t('added', { count: item.last30 })}
              </p>
              {key === 'organizations' && (
                <p className="text-xs text-muted-foreground">{t('added', { count: item.last30 })}</p>
              )}
              <p
                className={cn(
                  'flex items-center gap-1 text-xs',
                  g.change > 0 ? 'text-emerald-700 dark:text-emerald-400' : g.change < 0 ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                <Trend className="size-3.5 shrink-0" aria-hidden />
                <span>{g.text}</span>
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
