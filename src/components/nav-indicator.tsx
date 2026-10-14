'use client'

import { useLayoutEffect, useRef } from 'react'

/**
 * The active sidebar item's highlight: one element that springs between
 * items instead of each item cutting its own on and off. Place it first
 * inside a `relative group/nav` nav; it finds the item with
 * aria-current="page". Until it has placed itself (server render, first
 * paint) the active item draws its own highlight, so nothing flashes.
 * Only transform and opacity move; the height is set, never animated.
 */
export function NavIndicator({ active }: { active: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)

  useLayoutEffect(() => {
    const indicator = ref.current
    const nav = indicator?.parentElement
    if (!indicator || !nav) return
    const item = nav.querySelector<HTMLElement>('[aria-current="page"]')
    if (!item) {
      indicator.style.opacity = '0'
      return
    }
    // The first placement jumps; every later one slides
    if (!placed.current) indicator.style.transition = 'none'
    indicator.style.height = `${item.offsetHeight}px`
    indicator.style.transform = `translateY(${item.offsetTop}px)`
    indicator.style.opacity = '1'
    if (!placed.current) {
      void indicator.offsetHeight
      indicator.style.transition = ''
      placed.current = true
    }
    nav.dataset.indicator = 'ready'
  }, [active])

  return (
    <span
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-x-4 top-0 rounded-lg bg-accent opacity-0 transition-[transform,opacity] duration-(--motion-spring-duration) ease-spring before:absolute before:inset-y-1.5 before:start-0 before:w-[3px] before:rounded-full before:bg-primary"
    />
  )
}
