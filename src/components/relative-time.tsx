'use client'

import { useFormatter, useNow } from 'next-intl'

/** "5 minutes ago" style timestamp that keeps itself up to date. */
export function RelativeTime({ date, className }: { date: string; className?: string }) {
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const value = new Date(date)

  return (
    <time
      dateTime={date}
      title={format.dateTime(value, { dateStyle: 'medium', timeStyle: 'short' })}
      className={className}
      // server and browser clocks render slightly different "now"
      suppressHydrationWarning
    >
      {format.relativeTime(value, now)}
    </time>
  )
}
