import { cn } from '@/lib/utils'

// public/brand/mudrik-mark.svg is 1157 × 700; the lockup 13389 × 1962
const MARK_RATIO = 1157 / 700
const LOCKUP_RATIO = 13389 / 1962
/** The mark is illegible below this height; requests for less get this */
const MARK_MIN_HEIGHT = 28

/**
 * The mark alone, coloured by CSS (text-foreground, text-primary-foreground…): the
 * SVG is used as a mask over currentColor, so the file stays the one source.
 */
export function BrandMark({ height = MARK_MIN_HEIGHT, className }: { height?: number; className?: string }) {
  const h = Math.max(height, MARK_MIN_HEIGHT)
  return (
    <span
      role="img"
      aria-label="Mudrik AI"
      className={cn('inline-block shrink-0 bg-current', className)}
      style={{
        height: h,
        width: Math.round(h * MARK_RATIO),
        mask: 'url(/brand/mudrik-mark.svg) center / contain no-repeat',
        WebkitMask: 'url(/brand/mudrik-mark.svg) center / contain no-repeat',
      }}
    />
  )
}

/**
 * The mark's entrance plays once per browser session (see mark-entrance in
 * app/globals.css). Call this when it ends, so a shell mounted later in the
 * same page load does not play it again.
 */
export function markSeen() {
  document.documentElement.setAttribute('data-mark-seen', '')
}

/** For the root layout's <head>: every page load after the first in a session skips the entrance */
export const MARK_SEEN_SCRIPT = `(function(){try{var k="mudrik-mark-seen";if(sessionStorage.getItem(k))document.documentElement.setAttribute("data-mark-seen","");else sessionStorage.setItem(k,"1")}catch(e){document.documentElement.setAttribute("data-mark-seen","")}})()`

/** Mark + wordmark in the two brand colours (login, emails) */
export function BrandLockup({ height = 36, className }: { height?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a fixed-size SVG; next/image adds nothing
    <img
      src="/brand/mudrik-lockup.svg"
      alt="Mudrik AI"
      width={Math.round(height * LOCKUP_RATIO)}
      height={height}
      className={cn('shrink-0 select-none', className)}
      draggable={false}
    />
  )
}
