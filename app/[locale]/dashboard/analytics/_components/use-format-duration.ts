'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { durationParts } from '@/lib/format-duration'

/** "12 ث" / "2.5 د" / "1.2 س" in the current locale */
export function useFormatDuration() {
  const t = useTranslations('analytics.duration')
  const format = useFormatter()
  return (seconds: number) => {
    const { value, unit } = durationParts(seconds)
    return t(unit, { value: format.number(value) })
  }
}
