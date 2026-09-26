'use client'
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
import type { ClientOption } from '@/lib/auth/client-context'

type NavItem = { name: string; href: string; icon: LucideIcon; exact?: boolean }

const TEAM_ROLES = ['super_admin', 'org_admin', 'client_admin']

export function DashboardShell({
  children,
  user,
  clients,
  selectedClient,
  canSeeAll,
}: {
  children: React.ReactNode
  user: { email: string; fullName?: string | null; role?: string | null }
  clients: ClientOption[]
  selectedClient: ClientOption | null
  /** super/org admins: may pick "all clients" */
  canSeeAll: boolean
}) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('dashboard')
  const tCommon = useTranslations('common')
  const tClientNav = useTranslations('clientNav')

  const canManageTeam = TEAM_ROLES.includes(user.role ?? '')
  const teamItem: NavItem = { name: t('team'), href: '/dashboard/team', icon: UsersRound }
  const settingsItem: NavItem = { name: t('settings'), href: '/dashboard/settings', icon: Settings }

  // One client in focus: its own pages. All clients (org admins): org-wide pages.
  const navigation: NavItem[] = selectedClient
    ? [
        { name: t('overview'), href: '/dashboard', icon: LayoutDashboard, exact: true },
        { name: t('conversations'), href: '/dashboard/conversations', icon: MessagesSquare },
        { name: t('leads'), href: '/dashboard/leads', icon: Users },
        ...clientSections(selectedClient.id).map((section) => ({
          name: tClientNav(section.key),
          href: section.href,
          icon: section.icon,
        })),
        ...(canManageTeam ? [teamItem] : []),
        settingsItem,
      ]
    : [
        { name: t('overview'), href: '/dashboard', icon: LayoutDashboard, exact: true },
        { name: t('allConversations'), href: '/dashboard/conversations', icon: MessagesSquare },
        { name: t('allLeads'), href: '/dashboard/leads', icon: Users },
        ...(canSeeAll ? [{ name: t('clients'), href: '/dashboard/clients', icon: Building2 }] : []),
        ...(canManageTeam ? [teamItem] : []),
        settingsItem,
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
      <aside className="w-64 border-r bg-card flex flex-col">
               <div className="p-6 border-b flex items-center justify-between">
          <Link href="/dashboard" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-orange-500 flex items-center justify-center">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-lg">Advertema AI</span>
          </Link>
          <LanguageSwitcher />
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
      </aside>

      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}