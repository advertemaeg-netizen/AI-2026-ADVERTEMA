import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContext } from '@/lib/auth/client-context'
import { isOrgAdmin, isSuperAdmin } from '@/lib/auth/permissions'
import { getSession } from '@/lib/auth/session'
import { getUsageAlerts } from '@/lib/actions/subscription'
import { DashboardShell } from './_components/dashboard-shell'
import { UsageBanner } from './_components/usage-banner'
import { NeedsHumanBanner } from './_components/needs-human-banner'
import { ImpersonationBanner } from './_components/impersonation-banner'

const DAY = 24 * 60 * 60 * 1000

/**
 * Limit alerts and subscription state for the banner (org admins only). A
 * direct business has no organization subscription: its one client's plan
 * is the one it pays for.
 */
async function billingBanner(
  supabase: Awaited<ReturnType<typeof createClient>>,
  organizationId: string,
  directClientId: string | null
) {
  const subscription = directClientId
    ? supabase.from('client_subscriptions').select('status, trial_ends_at').eq('client_id', directClientId)
    : supabase.from('subscriptions').select('status, trial_ends_at').eq('organization_id', organizationId)
  const [alerts, { data: sub }] = await Promise.all([
    getUsageAlerts(),
    subscription.maybeSingle<{ status: string; trial_ends_at: string | null }>(),
  ])
  const trialEnd = sub?.status === 'trialing' && sub.trial_ends_at ? Date.parse(sub.trial_ends_at) : null
  const inactive = !!sub && (sub.status === 'cancelled' || (trialEnd !== null && trialEnd <= Date.now()))
  const trialDaysLeft = trialEnd !== null ? Math.max(0, Math.ceil((trialEnd - Date.now()) / DAY)) : null
  return { alerts, inactive, trialDaysLeft }
}

export default async function DashboardLayout({ children, params }: LayoutProps<'/[locale]/dashboard'>) {
  const { locale } = await params
  const { supabase, profile, impersonation } = await getSession()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !profile) redirect(`/${locale}/login`)
  // Super admins have no organization of their own: the admin panel is
  // theirs, and they see a customer's dashboard only by opening its account
  if (isSuperAdmin(profile.role)) redirect(`/${locale}/admin`)

  const [{ data: me }, { data: orgDisabled }] = await Promise.all([
    supabase.from('users').select('full_name').eq('id', user.id).single<{ full_name: string | null }>(),
    supabase.rpc('org_disabled'),
  ])

  // Members of a disabled organization are signed out (RLS already hides everything)
  if (orgDisabled) redirect('/auth/org-disabled')

  const context = await getClientContext()
  const directClientId = context?.orgType === 'direct' ? (context.selected?.id ?? null) : null
  const banner =
    isOrgAdmin(profile.role) && profile.organization_id
      ? await billingBanner(supabase, profile.organization_id, directClientId)
      : null

  // Conversations the assistant could not answer; RLS limits the count to
  // the ones this user handles
  const { count: needsHuman } = await supabase
    .from('conversations')
    .select('id', { count: 'exact', head: true })
    .not('needs_human_since', 'is', null)

  return (
    <DashboardShell
      clients={context?.clients ?? []}
      selectedClient={context?.selected ?? null}
      canSeeAll={context?.canSeeAll ?? false}
      orgType={context?.orgType ?? 'agency'}
      user={{
        email: user.email!,
        fullName: me?.full_name,
        role: profile.role,
      }}
      banner={impersonation && <ImpersonationBanner organizationName={impersonation.organizationName} />}
    >
      <NeedsHumanBanner count={needsHuman ?? 0} />
      {banner && <UsageBanner {...banner} />}
      {children}
    </DashboardShell>
  )
}