'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart'
import { CHANNEL_TYPES, type ChannelType } from '@/lib/types/channels'
import type { AnalyticsData } from '@/lib/types/analytics'
import { ChartCard } from './chart-card'

/*
 * Chart conventions (see the dataviz method): colors come from theme
 * variables (--chart-*, --chart-seq-*), one series = one color, 2px lines,
 * bars ≤ 24px with a 4px rounded data end, solid hairline grid, a tooltip on
 * every chart and a table view on every card. In RTL the category axis runs
 * right-to-left and the value axis sits on the right.
 */

const BAR_SIZE = 24
const GRID_STROKE = 'var(--border)'

function useRtl() {
  return useLocale() === 'ar'
}

type LabelBox = { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown }

/**
 * Value label just past a horizontal bar's data end. Recharts' own positions
 * are relative to where the rect starts, which is the wrong end once the
 * axis is reversed for RTL.
 */
function barEndLabel(rtl: boolean, formatValue: (value: number) => string) {
  function BarEndLabel({ x, y, width, height, value }: LabelBox) {
    const left = Number(x)
    const w = Number(width)
    const end = rtl ? Math.min(left, left + w) - 6 : Math.max(left, left + w) + 6
    return (
      <text
        x={end}
        y={Number(y) + Number(height) / 2}
        dy="0.35em"
        textAnchor={rtl ? 'end' : 'start'}
        className="fill-foreground text-xs"
      >
        {formatValue(Number(value))}
      </text>
    )
  }
  return BarEndLabel
}

// Color follows the channel, never its rank
const CHANNEL_COLORS: Record<ChannelType, string> = {
  website: 'var(--chart-1)',
  facebook: 'var(--chart-2)',
  instagram: 'var(--chart-3)',
  whatsapp: 'var(--chart-4)',
}

export function OverTimeChart({ data }: { data: AnalyticsData }) {
  const t = useTranslations('analytics')
  const format = useFormatter()
  const rtl = useRtl()
  const weekly = data.range.granularity === 'week'

  const config = {
    conversations: { label: t('series.conversations'), color: 'var(--chart-1)' },
    leads: { label: t('series.leads'), color: 'var(--chart-2)' },
  } satisfies ChartConfig

  const label = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`)
    return format.dateTime(d, { day: 'numeric', month: 'short' })
  }
  const empty = data.series.every((p) => p.conversations === 0 && p.leads === 0)

  return (
    <ChartCard
      title={t('charts.overTime.title')}
      description={weekly ? t('charts.overTime.weekly') : t('charts.overTime.daily')}
      empty={empty}
      table={{
        headers: [t('export.date'), t('series.conversations'), t('series.leads')],
        rows: data.series.map((p) => [label(p.date), p.conversations, p.leads]),
      }}
    >
      <ChartContainer config={config} className="aspect-auto h-72 w-full">
        <LineChart data={data.series} margin={{ top: 8, left: 8, right: 8 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="date"
            reversed={rtl}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={label}
          />
          <YAxis
            orientation={rtl ? 'right' : 'left'}
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <ChartTooltip
            cursor={{ stroke: 'var(--border)' }}
            content={<ChartTooltipContent indicator="line" labelFormatter={(value) => label(String(value))} />}
          />
          <ChartLegend content={<ChartLegendContent />} />
          {(['conversations', 'leads'] as const).map((key) => (
            <Line
              key={key}
              isAnimationActive={false}
              dataKey={key}
              type="monotone"
              stroke={`var(--color-${key})`}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--card)' }}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </ChartCard>
  )
}

export function ChannelsChart({ data }: { data: AnalyticsData }) {
  const t = useTranslations('analytics')
  const tChannels = useTranslations('channels')
  const format = useFormatter()

  const total = data.channels.reduce((sum, c) => sum + c.conversations, 0)
  const slices = data.channels.filter((c) => c.conversations > 0)
  const share = (n: number) => format.number(total ? n / total : 0, { style: 'percent', maximumFractionDigits: 1 })

  const config = Object.fromEntries(
    CHANNEL_TYPES.map((type) => [type, { label: tChannels(`types.${type}`), color: CHANNEL_COLORS[type] }])
  ) satisfies ChartConfig

  return (
    <ChartCard
      title={t('charts.channels.title')}
      description={t('charts.channels.description')}
      empty={total === 0}
      table={{
        headers: [t('series.channel'), t('series.conversations'), t('series.share')],
        rows: data.channels.map((c) => [tChannels(`types.${c.channel}`), c.conversations, share(c.conversations)]),
      }}
    >
      {slices.length < 2 ? (
        // A one-slice donut says nothing: state the fact instead
        <div className="flex h-56 flex-col items-center justify-center gap-1 text-center">
          <p className="text-4xl font-semibold">{share(slices[0]?.conversations ?? 0)}</p>
          <p className="text-sm text-muted-foreground">
            {t('charts.channels.single', {
              channel: slices[0] ? tChannels(`types.${slices[0].channel}`) : '—',
              count: slices[0]?.conversations ?? 0,
            })}
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <ChartContainer config={config} className="aspect-square h-56">
            <PieChart accessibilityLayer>
              <ChartTooltip content={<ChartTooltipContent nameKey="channel" hideLabel />} />
              <Pie
                isAnimationActive={false}
                data={slices}
                dataKey="conversations"
                nameKey="channel"
                innerRadius="60%"
                outerRadius="90%"
                paddingAngle={1}
                stroke="var(--card)"
                strokeWidth={2}
              >
                {slices.map((slice) => (
                  <Cell key={slice.channel} fill={`var(--color-${slice.channel})`} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          {/* Legend with values: identity never rests on color alone */}
          <ul className="grid min-w-40 flex-1 gap-2 text-sm">
            {slices.map((slice) => (
              <li key={slice.channel} className="flex items-center gap-2">
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: CHANNEL_COLORS[slice.channel] }} />
                <span className="flex-1">{tChannels(`types.${slice.channel}`)}</span>
                <span className="font-medium tabular-nums">{format.number(slice.conversations)}</span>
                <span className="w-14 text-end text-muted-foreground tabular-nums">{share(slice.conversations)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  )
}

export function PeakHoursChart({ data }: { data: AnalyticsData }) {
  const t = useTranslations('analytics')
  const rtl = useRtl()
  const config = { messages: { label: t('series.messages'), color: 'var(--chart-1)' } } satisfies ChartConfig
  const hour = (h: number) => `${String(h).padStart(2, '0')}:00`
  const busiest = data.peakHours.reduce((best, h) => (h.messages > best.messages ? h : best), data.peakHours[0])

  return (
    <ChartCard
      title={t('charts.peakHours.title')}
      description={
        busiest && busiest.messages > 0
          ? t('charts.peakHours.busiest', { hour: hour(busiest.hour) })
          : t('charts.peakHours.description')
      }
      empty={data.peakHours.every((h) => h.messages === 0)}
      table={{
        headers: [t('export.hour'), t('series.messages')],
        rows: data.peakHours.map((h) => [hour(h.hour), h.messages]),
      }}
    >
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <BarChart data={data.peakHours} margin={{ top: 8, left: 8, right: 8 }} barCategoryGap={2} accessibilityLayer>
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis
            dataKey="hour"
            reversed={rtl}
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval={2}
            tickFormatter={(h: number) => String(h).padStart(2, '0')}
          />
          <YAxis orientation={rtl ? 'right' : 'left'} allowDecimals={false} tickLine={false} axisLine={false} width={32} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent labelFormatter={(_, payload) => hour(Number(payload?.[0]?.payload?.hour ?? 0))} />}
          />
          <Bar isAnimationActive={false} dataKey="messages" fill="var(--color-messages)" maxBarSize={BAR_SIZE} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  )
}

export function FunnelChart({ data }: { data: AnalyticsData }) {
  const t = useTranslations('analytics')
  const format = useFormatter()
  const rtl = useRtl()

  const steps = [
    { key: 'conversations', value: data.funnel.conversations },
    { key: 'leads', value: data.funnel.leads },
    { key: 'appointments', value: data.funnel.booked },
    { key: 'attended', value: data.funnel.showedUp },
  ].map((step, i, all) => ({
    ...step,
    label: t(`charts.funnel.steps.${step.key}`),
    // rate from the previous stage
    rate: i > 0 && all[i - 1].value > 0 ? step.value / all[i - 1].value : null,
    // ordered stages → one-hue ramp, later stages deeper
    fill: `var(--chart-seq-${i + 1})`,
  }))
  const config = { value: { label: t('series.count') } } satisfies ChartConfig
  const pct = (r: number | null) => (r === null ? '' : format.number(r, { style: 'percent', maximumFractionDigits: 1 }))

  return (
    <ChartCard
      title={t('charts.funnel.title')}
      description={t('charts.funnel.description')}
      empty={steps.every((s) => s.value === 0)}
      table={{
        headers: [t('charts.funnel.stage'), t('series.count'), t('charts.funnel.fromPrevious')],
        rows: steps.map((s) => [s.label, s.value, pct(s.rate) || '—']),
      }}
    >
      <ChartContainer config={config} className="aspect-auto h-60 w-full">
        <BarChart
          data={steps}
          layout="vertical"
          // room past the longest bar for its value label
          margin={rtl ? { left: 40, right: 8 } : { left: 8, right: 40 }}
          barCategoryGap={8}
          accessibilityLayer
        >
          <XAxis type="number" hide reversed={rtl} />
          <YAxis
            type="category"
            dataKey="label"
            orientation={rtl ? 'right' : 'left'}
            tickLine={false}
            axisLine={false}
            width={90}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator />} />
          <Bar isAnimationActive={false} dataKey="value" maxBarSize={BAR_SIZE} radius={rtl ? [4, 0, 0, 4] : [0, 4, 4, 0]}>
            {steps.map((step) => (
              <Cell key={step.key} fill={step.fill} />
            ))}
            <LabelList dataKey="value" content={barEndLabel(rtl, (v) => format.number(v))} />
          </Bar>
        </BarChart>
      </ChartContainer>
      <ol className="mt-2 grid grid-cols-3 gap-2 text-center text-xs text-muted-foreground">
        {steps.slice(1).map((step) => (
          <li key={step.key}>
            <span className="block text-sm font-medium text-foreground">{pct(step.rate) || '—'}</span>
            {t('charts.funnel.rateTo', { stage: step.label })}
          </li>
        ))}
      </ol>
    </ChartCard>
  )
}

export function LeadStatusChart({ data }: { data: AnalyticsData }) {
  const t = useTranslations('analytics')
  const tLeads = useTranslations('leads')
  const format = useFormatter()
  const rtl = useRtl()

  const rows = data.leadStatuses.map((s) => ({ ...s, label: tLeads(`status.${s.status}`) }))
  // Statuses are nominal: one series, one color
  const config = { leads: { label: t('series.leads'), color: 'var(--chart-1)' } } satisfies ChartConfig

  return (
    <ChartCard
      title={t('charts.leadStatus.title')}
      description={t('charts.leadStatus.description')}
      empty={rows.every((r) => r.leads === 0)}
      table={{ headers: [t('series.status'), t('series.leads')], rows: rows.map((r) => [r.label, r.leads]) }}
    >
      <ChartContainer config={config} className="aspect-auto h-64 w-full">
        <BarChart
          data={rows}
          layout="vertical"
          margin={rtl ? { left: 40, right: 8 } : { left: 8, right: 40 }}
          barCategoryGap={6}
          accessibilityLayer
        >
          <CartesianGrid horizontal={false} stroke={GRID_STROKE} />
          <XAxis type="number" hide reversed={rtl} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="label"
            orientation={rtl ? 'right' : 'left'}
            tickLine={false}
            axisLine={false}
            width={110}
          />
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator />} />
          <Bar isAnimationActive={false} dataKey="leads" fill="var(--color-leads)" maxBarSize={BAR_SIZE} radius={rtl ? [4, 0, 0, 4] : [0, 4, 4, 0]}>
            <LabelList dataKey="leads" content={barEndLabel(rtl, (v) => format.number(v))} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </ChartCard>
  )
}
