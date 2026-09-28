'use client'
import { useState } from 'react'
import { LanguageSwitcher } from '@/components/language-switcher'
import { usePathname } from '@/i18n/navigation'
import { Link, useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import {
  LayoutDashboard,
  MessagesSquare,
  Users,
  Building2,
  Settings,
  LogOut,
  Sparkles,
  UsersRound,
  CalendarDays,
  BarChart3,
  CreditCard,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
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
import { clientSections } from '@/components/client-sections'
import { ClientSwitcher } from '@/components/client-switcher'
import { canManageClient, isOrgAdmin } from '@/lib/auth/permissions'
import { endImpersonation } from '@/lib/actions/impersonation'
import { BottomNav, MobileTopBar } from './mobile-nav'
import type { ClientOption, OrgType } from '@/lib/auth/client-context'

type NavItem = { name: string; href: string; icon: LucideIcon; exact?: boolean }

export function DashboardShell({
  children,
  user,
  clients,
  selectedClient,
  canSeeAll,
  orgType,
  banner,
}: {
  children: React.ReactNode
  /** Above everything (a super admin viewing this account) */
  banner?: React.ReactNode
  user: { email: string; fullName?: string | null; role?: string | null }
  clients: ClientOption[]
  selectedClient: ClientOption | null
  /** super/org admins: may pick "all clients" */
  canSeeAll: boolean
  /** direct: a single business — its pages directly, no clients or billing */
  orgType: OrgType
}) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('dashboard')
  const tCommon = useTranslations('common')
  const tClientNav = useTranslations('clientNav')

  // Team members only work conversations, leads, appointments and the overview
  const canManage = canManageClient(user.role)
  const teamItem: NavItem = { name: t('team'), href: '/dashboard/team', icon: UsersRound }
  const settingsItem: NavItem = { name: t('settings'), href: '/dashboard/settings', icon: Settings }
  // Billing is the organization admins' business: the agency's own plan
  // (paid to the platform) and billing its clients. A client's own plan is
  // one of the client's pages.
  const billingItems: NavItem[] = isOrgAdmin(user.role)
    ? [
        { name: t('subscription'), href: '/dashboard/subscription', icon: CreditCard },
        { name: t('billing'), href: '/dashboard/billing', icon: Wallet },
      ]
    : []

  // One client in focus: its own pages. All clients (org admins): org-wide pages.
  // A direct business is one client: the client's own pages sit at the top
  // level, and its subscription is the business's (no clients, no billing)
  const directNavigation: NavItem[] | null =
    orgType === 'direct' && selectedClient
      ? [
          { name: t('overview'), href: '/dashboard', icon: LayoutDashboard, exact: true },
          { name: t('analytics'), href: '/dashboard/analytics', icon: BarChart3 },
          { name: t('conversations'), href: '/dashboard/conversations', icon: MessagesSquare },
          { name: t('leads'), href: '/dashboard/leads', icon: Users },
          { name: t('appointments'), href: '/dashboard/appointments', icon: CalendarDays },
          ...(canManage
            ? clientSections(selectedClient.id)
                .filter((section) => section.key !== 'subscription')
                .map((section) => ({ name: tClientNav(section.key), href: section.href, icon: section.icon }))
            : []),
          ...(canManage ? [teamItem] : []),
          ...(isOrgAdmin(user.role)
            ? [{ name: t('subscription'), href: '/dashboard/subscription', icon: CreditCard }]
            : []),
          settingsItem,
        ]
      : null

  const navigation: NavItem[] = directNavigation ?? (selectedClient
    ? [
        { name: t('overview'), href: '/dashboard', icon: LayoutDashboard, exact: true },
        { name: t('analytics'), href: '/dashboard/analytics', icon: BarChart3 },
        { name: t('conversations'), href: '/dashboard/conversations', icon: MessagesSquare },
        { name: t('leads'), href: '/dashboard/leads', icon: Users },
        { name: t('appointments'), href: '/dashboard/appointments', icon: CalendarDays },
        ...(canManage
          ? clientSections(selectedClient.id).map((section) => ({
              name: tClientNav(section.key),
              href: section.href,
              icon: section.icon,
            }))
          : []),
        ...(canManage ? [teamItem] : []),
        ...billingItems,
        settingsItem,
      ]
    : [
        { name: t('overview'), href: '/dashboard', icon: LayoutDashboard, exact: true },
        { name: t('analytics'), href: '/dashboard/analytics', icon: BarChart3 },
        { name: t('allConversations'), href: '/dashboard/conversations', icon: MessagesSquare },
        { name: t('allLeads'), href: '/dashboard/leads', icon: Users },
        { name: t('appointments'), href: '/dashboard/appointments', icon: CalendarDays },
        ...(canSeeAll ? [{ name: t('clients'), href: '/dashboard/clients', icon: Building2 }] : []),
        ...(canManage ? [teamItem] : []),
        ...billingItems,
        settingsItem,
      ])

  const initials = (user.fullName || user.email)
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)

  // Phones: the sidebar lives in a sheet; following a link closes it
  const [menuOpen, setMenuOpen] = useState(false)

  async function handleLogout() {
    // Signing out also ends a super admin's view of this account
    await endImpersonation()
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  function closeMenu() {
    setMenuOpen(false)
  }

  function sidebar(inSheet: boolean) {
    return (
      <>
        <div className={cn('p-6 border-b flex items-center justify-between', inSheet && 'p-4 pe-14')}>
          <Link href="/dashboard" className="flex items-center gap-2" onClick={closeMenu}>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-orange-500 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-lg">Connecta AI</span>
          </Link>
          {/* Phones have it in the top bar */}
          {!inSheet && <LanguageSwitcher />}
        </div>

        {/* Everyone who can see more than one client can switch; org admins also get "all" */}
        {(canSeeAll || clients.length > 1) && (
          <div className="border-b p-4">
            <ClientSwitcher clients={clients} selectedId={selectedClient?.id ?? null} allowAll={canSeeAll} />
          </div>
        )}
        {!canSeeAll && clients.length === 1 && selectedClient && (
          <div className="flex items-center gap-2 border-b px-6 py-3 text-sm font-medium">
            <Building2 className="size-4 text-muted-foreground" />
            <span className="truncate">{selectedClient.name}</span>
          </div>
        )}

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
                onClick={closeMenu}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
                  inSheet && 'min-h-11',
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

        <div className="p-4 border-t">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="w-full justify-start px-2 h-auto py-2">
                <Avatar className="w-8 h-8 me-2">
                  <AvatarFallback className="text-xs">{initials}</AvatarFallback>
                </Avatar>
                <div className="flex flex-col items-start text-start overflow-hidden">
                  <span className="text-sm font-medium truncate w-full">
                    {user.fullName || 'User'}
                  </span>
                  <span className="text-xs text-muted-foreground truncate w-full">
                    {user.email}
                  </span>
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <div className="flex flex-col">
                  <span>{user.fullName || 'User'}</span>
                  <span className="text-xs text-muted-foreground font-normal">
                    {user.role}
                  </span>
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
      </>
    )
  }

  return (
    <div className="flex h-screen flex-col bg-background print:block print:h-auto max-md:h-dvh">
      {banner}
      <MobileTopBar title={selectedClient?.name} open={menuOpen} onOpenChange={setMenuOpen}>
        <div className="flex min-h-0 flex-1 flex-col">{sidebar(true)}</div>
      </MobileTopBar>
      <div className="flex min-h-0 flex-1 print:block">
        <aside className="w-64 border-e bg-card flex flex-col print:hidden max-md:hidden">
          {sidebar(false)}
        </aside>

        <main className="flex flex-1 flex-col overflow-y-auto print:block print:overflow-visible">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  )
}