'use client'

import { useLayoutEffect, useRef } from 'react'
import { useFormatter, type NumberFormatOptions } from 'next-intl'
import { cn } from '@/lib/utils'

/** next-intl's number options (its own type, stricter than Intl's) */
export type CountUpOptions = NumberFormatOptions

/**
 * A number that counts up from zero when it first paints. The server renders
 * the final value, so without JavaScript, and under reduced motion (where
 * --motion-count-duration is 0), the final value is what shows. Each frame
 * rewrites the text node React owns; tabular figures keep the width steady.
 */
export function CountUp({
  value,
  options,
  className,
}: {
  value: number
  options?: CountUpOptions
  className?: string
}) {
  const format = useFormatter()
  const ref = useRef<HTMLSpanElement>(null)
  const final = format.number(value, options)

  useLayoutEffect(() => {
    const text = ref.current?.firstChild
    if (!ref.current || !text || value === 0) return
    // The minifier may write the token in seconds (.9s) or milliseconds
    const token = getComputedStyle(ref.current).getPropertyValue('--motion-count-duration').trim()
    const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000)
    if (!(duration > 0)) return
    // Whole numbers count in whole steps; fractions keep the final precision
    const step = Number.isInteger(value) ? (n: number) => Math.round(n) : (n: number) => n
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - progress) ** 4
      text.nodeValue = progress < 1 ? format.number(step(value * eased), options) : final
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    text.nodeValue = format.number(0, options)
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      text.nodeValue = final
    }
    // Only a new value restarts the count; the formatter and options are stable per render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <span ref={ref} className={cn('tabular-nums', className)}>
      {final}
    </span>
  )
}
