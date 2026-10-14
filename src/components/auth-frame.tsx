import { BrandLockup } from '@/components/brand'

/** A text link on the signed-out pages: the action colour, darker on hover */
export const authLinkClass =
  'font-medium text-primary underline-offset-4 transition-colors duration-fast hover:text-primary-strong hover:underline'

/** The frame of the signed-out pages: lockup, then the card, rising in */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden bg-background p-4">
      {/* A warm wash behind the card; purely decorative */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-[radial-gradient(ellipse_at_top,var(--accent),transparent_70%)]"
      />
      <BrandLockup height={40} className="relative animate-enter" />
      <div className="relative w-full max-w-md animate-enter stagger" style={{ '--i': 2 } as React.CSSProperties}>
        {children}
      </div>
    </div>
  )
}
