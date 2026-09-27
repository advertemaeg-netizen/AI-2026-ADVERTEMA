import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContext } from '@/lib/auth/client-context'
import { DashboardShell } from './_components/dashboard-shell'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const [{ data: profile }, { data: orgDisabled }] = await Promise.all([
    supabase.from('users').select('*').eq('id', user.id).single(),
    supabase.rpc('org_disabled'),
  ])

  // Members of a disabled organization are signed out (RLS already hides everything)
  if (orgDisabled) redirect('/auth/org-disabled')

  const context = await getClientContext()

  return (
    <DashboardShell
      clients={context?.clients ?? []}
      selectedClient={context?.selected ?? null}
      canSeeAll={context?.canSeeAll ?? false}
      user={{
        email: user.email!,
        fullName: profile?.full_name,
        role: profile?.role,
      }}
    >
      {children}
    </DashboardShell>
  )
}