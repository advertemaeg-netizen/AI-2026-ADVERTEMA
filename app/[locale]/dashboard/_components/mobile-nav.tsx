'use client'

import { useTranslations } from 'next-intl'
import { CalendarDays, LayoutDashboard, Menu, MessagesSquare, Sparkles, Users, type LucideIcon } from 'lucide-react'
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
    <header className="flex shrink-0 items-center gap-1 border-b bg-card px-1 pt-[env(safe-area-inset-top)] md:hidden print:hidden">
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="size-11" aria-label={t('openMenu')}>
            <Menu className="size-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="start" className="gap-0 bg-card p-0" closeLabel={t('closeMenu')}>
          <SheetTitle className="sr-only">{t('menu')}</SheetTitle>
          {children}
        </SheetContent>
      </Sheet>

      <Link href="/dashboard" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-1">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-orange-500">
          <Sparkles className="size-3.5 text-white" />
        </span>
        <span className="min-w-0">
          <span className="block text-sm leading-tight font-semibold">Connecta AI</span>
          {title && <span className="block truncate text-xs leading-tight text-muted-foreground">{title}</span>}
        </span>
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

// Inside a conversation the reply box owns the bottom of the screen
const CONVERSATION_THREAD = /^\/dashboard\/conversations\/[^/]+$/

export function BottomNav() {
  const t = useTranslations('mobileNav')
  const pathname = usePathname()
  if (CONVERSATION_THREAD.test(pathname)) return null

  return (
    <nav
      data-slot="bottom-nav"
      aria-label={t('bottomNav')}
      className="shrink-0 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
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
                  'flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                <span className={cn('flex h-7 w-12 items-center justify-center rounded-full transition-colors', active && 'bg-accent')}>
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
