'use client'

import { useTranslations } from 'next-intl'
import { ArrowLeft, Building2, CreditCard, LayoutDashboard, LogOut, Package, Receipt, Settings, ShieldCheck, Sparkles, type LucideIcon } from 'lucide-react'
import { Link, usePathname, useRouter } from '@/i18n/navigation'
import { LanguageSwitcher } from '@/components/language-switcher'
import { createClient } from '@/lib/supabase/client'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

type NavItem = { name: string; href: string; icon: LucideIcon; exact?: boolean }

export function AdminShell({
  children,
  user,
}: {
  children: React.ReactNode
  user: { email: string; fullName?: string | null }
}) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('admin')
  const tCommon = useTranslations('common')

  const navigation: NavItem[] = [
    { name: t('nav.overview'), href: '/admin', icon: LayoutDashboard, exact: true },
    { name: t('nav.organizations'), href: '/admin/organizations', icon: Building2 },
    { name: t('nav.plans'), href: '/admin/plans', icon: Package },
    { name: t('nav.subscriptions'), href: '/admin/subscriptions', icon: CreditCard },
    { name: t('nav.invoices'), href: '/admin/invoices', icon: Receipt },
    { name: t('nav.settings'), href: '/admin/settings', icon: Settings },
  ]

  const initials = (user.fullName || user.email)
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="flex h-screen bg-background">
      <aside className="w-64 border-e bg-card flex flex-col">
        <div className="p-6 border-b flex items-center justify-between">
          <Link href="/admin" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-orange-500 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-lg">Advertema AI</span>
          </Link>
          <LanguageSwitcher />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-4">
          {navigation.map((item) => {
            const isActive = item.exact
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                )}
              >
                <item.icon className="w-4 h-4" />
                {item.name}
              </Link>
            )
          })}
        </nav>

        <div className="border-t p-4 grid gap-2">
          <Button variant="outline" size="sm" className="justify-start" asChild>
            <Link href="/dashboard">
              <ArrowLeft className="rtl:rotate-180" />
              {t('nav.backToDashboard')}
            </Link>
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="w-full justify-start px-2 h-auto py-2">
                <Avatar className="w-8 h-8 me-2">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col items-start text-start overflow-hidden">
                  <span className="text-sm font-medium truncate w-full">{user.fullName || 'User'}</span>
                  <span className="text-xs text-muted-foreground truncate w-full">{user.email}</span>
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span>{user.fullName || 'User'}</span>
                  <span className="text-xs text-muted-foreground font-normal">{t('badge')}</span>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout}>
                <LogOut className="w-4 h-4 me-2" />
                {tCommon('logout')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-8 py-3 backdrop-blur">
          <Badge variant="destructive" className="gap-1.5 px-3 py-1 text-sm">
            <ShieldCheck />
            {t('badge')}
          </Badge>
          <span className="text-sm text-muted-foreground">{t('badgeHint')}</span>
        </header>
        {children}
      </main>
    </div>
  )
}
