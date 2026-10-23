import { cn } from '@/lib/utils'

// public/brand/mudrik-logo.svg: the guidelines' file, its viewBox cropped to the
// wordmark's tight bounds (771.8 × 142.7). The M is 136.1 of that height.
const LOGO_RATIO = 771.8 / 142.7
const M_RATIO = 136.1 / 142.7
/** The guidelines' minimum digital width */
const LOGO_MIN_WIDTH = 120

/**
 * The logo, as the file and nothing else: scaled, never redrawn, no shadow or
 * border, no animation that turns or stretches it. Coloured by CSS
 * (text-foreground for charcoal, text-primary-foreground for white): the SVG
 * is a mask over currentColor, so one file serves both versions. On
 * signature yellow, use the charcoal one.
 *
 * Its clear space, the height of the M on every side, is this element's
 * margin, so it travels with the logo and is never baked into the file.
 * Requests under the minimum width get the minimum.
 */
export function BrandLogo({ height = 24, className }: { height?: number; className?: string }) {
  const h = Math.max(height, LOGO_MIN_WIDTH / LOGO_RATIO)
  const mask = 'url(/brand/mudrik-logo.svg) center / contain no-repeat'
  return (
    <span
      role="img"
      aria-label="Mudrik AI"
      className={cn('block shrink-0 bg-current', className)}
      style={{ height: h, width: h * LOGO_RATIO, margin: Math.ceil(h * M_RATIO), mask, WebkitMask: mask }}
    />
  )
}
