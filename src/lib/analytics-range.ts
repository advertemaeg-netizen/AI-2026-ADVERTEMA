import { TZDate } from '@date-fns/tz'
import { startOfMonth } from 'date-fns'
import { CAIRO_TZ, cairoDayStart, cairoParts, cairoWallTimeToIso } from '@/lib/cairo-time'
import { ANALYTICS_PRESETS, type AnalyticsPreset, type AnalyticsRange } from '@/lib/types/analytics'

const DAY = 24 * 60 * 60 * 1000
export const MAX_RANGE_DAYS = 366
/** Longer periods plot weekly so the line stays readable */
const WEEKLY_AFTER_DAYS = 62
const DATE = /^\d{4}-\d{2}-\d{2}$/

function cairoMidnight(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(cairoWallTimeToIso(y, m - 1, d, '00:00'))
}

/**
 * The period for the analytics page from URL params (?range=7d, or
 * ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD in Cairo dates, inclusive).
 * Presets run from a Cairo midnight up to now; anything invalid falls back
 * to the last 30 days.
 */
export function parseAnalyticsRange(
  params: Record<string, string | string[] | undefined>,
  now: Date = new Date()
): AnalyticsRange {
  const one = (key: string) => (typeof params[key] === 'string' ? (params[key] as string) : undefined)
  const preset = (ANALYTICS_PRESETS as readonly string[]).includes(one('range') ?? '')
    ? (one('range') as AnalyticsPreset)
    : '30d'

  let from: Date
  let to: Date = now
  let resolved: AnalyticsPreset = preset

  if (preset === 'custom') {
    const f = one('from')
    const t = one('to')
    const fromDay = f && DATE.test(f) ? cairoMidnight(f) : null
    const toDay = t && DATE.test(t) ? cairoMidnight(t) : null
    if (
      fromDay && toDay && !Number.isNaN(fromDay.getTime()) && !Number.isNaN(toDay.getTime()) &&
      fromDay <= toDay && toDay.getTime() - fromDay.getTime() < MAX_RANGE_DAYS * DAY
    ) {
      from = fromDay
      // inclusive end date: up to the next Cairo midnight, never past now
      const end = cairoDayStart(1, toDay)
      to = end < now ? end : now
    } else {
      resolved = '30d'
      from = cairoDayStart(-29, now)
    }
  } else if (preset === 'today') {
    from = cairoDayStart(0, now)
  } else if (preset === '7d') {
    from = cairoDayStart(-6, now)
  } else if (preset === 'month') {
    from = new Date(startOfMonth(new TZDate(now.getTime(), CAIRO_TZ)).getTime())
  } else {
    from = cairoDayStart(-29, now)
  }

  const days = (to.getTime() - from.getTime()) / DAY
  return {
    preset: resolved,
    from: from.toISOString(),
    to: to.toISOString(),
    fromDate: cairoParts(from).dateKey,
    toDate: cairoParts(new Date(to.getTime() - 1)).dateKey,
    granularity: days > WEEKLY_AFTER_DAYS ? 'week' : 'day',
  }
}

/** The period of the same length right before, for comparisons. */
export function previousRange(from: string, to: string) {
  const start = new Date(from).getTime()
  const length = new Date(to).getTime() - start
  return { from: new Date(start - length).toISOString(), to: new Date(start).toISOString() }
}
