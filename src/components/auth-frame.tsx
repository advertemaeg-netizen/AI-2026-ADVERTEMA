import { BrandLogo } from '@/components/brand'

/** A text link on the signed-out pages: the action colour, darker on hover */
export const authLinkClass =
  'font-medium text-primary underline-offset-4 hover:text-primary-strong hover:underline'

/** The frame of the signed-out pages: the logo, then the card, rising in */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    // The background field (app/globals.css) shows through: no fill of its own
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-8 overflow-hidden p-4">
      <BrandLogo height={36} className="relative animate-enter text-foreground" />
      <div className="relative w-full max-w-md animate-enter stagger" style={{ '--i': 2 } as React.CSSProperties}>
        {children}
      </div>
    </div>
  )
}
