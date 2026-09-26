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

export function DashboardShell({
  children,
  user,
}: {
  children: React.ReactNode
  user: { email: string; fullName?: string | null; role?: string | null }
}) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()
  const t = useTranslations('dashboard')
  const tCommon = useTranslations('common')

  const navigation = [
    { name: t('overview'), href: '/dashboard', icon: LayoutDashboard },
    { name: t('conversations'), href: '/dashboard/conversations', icon: MessagesSquare },
    { name: t('leads'), href: '/dashboard/leads', icon: Users },
    { name: t('clients'), href: '/dashboard/clients', icon: Building2 },
    { name: t('settings'), href: '/dashboard/settings', icon: Settings },
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

        <nav className="flex-1 p-4 space-y-1">
          {navigation.map((item) => {
            const isActive =
              item.href === '/dashboard'
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
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