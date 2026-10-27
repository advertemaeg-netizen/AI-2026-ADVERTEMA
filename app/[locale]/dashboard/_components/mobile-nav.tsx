'use client'

import { useTranslations } from 'next-intl'
import { CalendarDays, LayoutDashboard, Menu, MessagesSquare, Users, type LucideIcon } from 'lucide-react'
import { BrandLogo } from '@/components/brand'
import { Link, usePathname } from '@/i18n/navigation'
import { LanguageSwitcher } from '@/components/language-switcher'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import { cn } from '@/lib/utils'

/**
 * Phones (under md): a top bar whose menu opens the full sidebar in a sheet
 * from the start side, and a bottom bar with the four places an owner opens
 * the app for. The desktop sidebar is untouched.
 */
export function MobileTopBar({
  title,
  open,
  onOpenChange,
  children,
}: {
  /** The client in focus, or the organization */
  title?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The sidebar's content */
  children: React.ReactNode
}) {
  const t = useTranslations('mobileNav')

  return (
    <header className="glass glass-page flex shrink-0 items-center gap-1 border-b px-1 pt-[env(safe-area-inset-top)] md:hidden print:hidden">
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11" aria-label={t('openMenu')}>
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="start" className="gap-0 p-0" closeLabel={t('closeMenu')}>
          <SheetTitle className="sr-only">{t('menu')}</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>

      {/* The logo at its minimum width; its margin is its clear space, so the client's name sits past it */}
      <Link href="/dashboard" className="flex min-h-11 min-w-0 flex-1 items-center">
        <BrandLogo height={0} className="text-foreground" />
        {title && <span className="min-w-0 truncate text-xs text-muted-foreground">{title}</span>}
      </Link>

      <div className="[&_button]:size-11">
        <LanguageSwitcher />
      </div>
    </header>
  )
}

type BottomItem = { key: 'home' | 'conversations' | 'leads' | 'appointments'; href: string; icon: LucideIcon; exact?: boolean }

const BOTTOM_ITEMS: BottomItem[] = [
  { key: 'home', href: '/dashboard', icon: LayoutDashboard, exact: true },
  { key: 'conversations', href: '/dashboard/conversations', icon: MessagesSquare },
  { key: 'leads', href: '/dashboard/leads', icon: Users },
  { key: 'appointments', href: '/dashboard/appointments', icon: CalendarDays },
]

// Inside a conversation the reply box owns the bottom of the screen (the
// install card hides with the nav, so the two never stack there)
export const CONVERSATION_THREAD = /^\/dashboard\/conversations\/[^/]+$/

export function BottomNav() {
  const t = useTranslations('mobileNav')
  const pathname = usePathname()
  if (CONVERSATION_THREAD.test(pathname)) return null

  return (
    <nav
      data-slot="bottom-nav"
      aria-label={t('bottomNav')}
      className="glass-solid shrink-0 border-t pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
    >
      <ul className="grid grid-cols-4">
        {BOTTOM_ITEMS.map((item) => {
          const active = item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`)
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium',
                  active ? 'text-primary' : 'text-muted-foreground'
                )}
              >
                <span
                  className={cn(
                    // The pill is a ::before that fades and springs in: only opacity and transform move
                    'relative isolate flex h-7 w-12 items-center justify-center before:absolute before:inset-0 before:-z-10 before:rounded-full before:bg-brand before:transition-[opacity,transform] before:duration-(--motion-spring-duration) before:ease-spring',
                    active ? 'before:scale-100 before:opacity-100' : 'before:scale-75 before:opacity-0'
                  )}
                >
                  <item.icon className="size-5" />
                </span>
                {t(item.key)}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
