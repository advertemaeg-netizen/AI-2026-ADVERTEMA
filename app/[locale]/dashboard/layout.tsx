import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContext } from '@/lib/auth/client-context'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { getUsageAlerts } from '@/lib/actions/subscription'
import { DashboardShell } from './_components/dashboard-shell'
import { UsageBanner } from './_components/usage-banner'

const DAY = 24 * 60 * 60 * 1000

/** Limit alerts and subscription state for the banner (org admins only). */
async function billingBanner(supabase: Awaited<ReturnType<typeof createClient>>, organizationId: string) {
  const [alerts, { data: sub }] = await Promise.all([
    getUsageAlerts(),
    supabase
      .from('subscriptions')
      .select('status, trial_ends_at')
      .eq('organization_id', organizationId)
      .maybeSingle<{ status: string; trial_ends_at: string | null }>(),
  ])
  const trialEnd = sub?.status === 'trialing' && sub.trial_ends_at ? Date.parse(sub.trial_ends_at) : null
  const inactive = !!sub && (sub.status === 'cancelled' || (trialEnd !== null && trialEnd <= Date.now()))
  const trialDaysLeft = trialEnd !== null ? Math.max(0, Math.ceil((trialEnd - Date.now()) / DAY)) : null
  return { alerts, inactive, trialDaysLeft }
}

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

  const [context, banner] = await Promise.all([
    getClientContext(),
    isOrgAdmin(profile?.role) && profile?.organization_id ? billingBanner(supabase, profile.organization_id) : null,
  ])

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
      {banner && <UsageBanner {...banner} />}
      {children}
    </DashboardShell>
  )
}