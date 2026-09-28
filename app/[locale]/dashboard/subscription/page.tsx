import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ArrowRight, Wallet } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { UsageBars } from '@/components/billing/usage-bars'
import { InvoicesTable } from '@/components/billing/invoices-table'
import { getSession } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { getAvailablePlans, getInvoices, getSubscription } from '@/lib/actions/subscription'
import { getClientAvailablePlans, getClientInvoices, getClientSubscription } from '@/lib/actions/client-subscription'
import { getClientContext } from '@/lib/auth/client-context'
import { CurrentPlanCard } from '@/components/billing/current-plan-card'
import { PlanPicker, type SalesContact } from './_components/plan-picker'

// wa.me wants digits only (country code, no + or spaces)
function salesContact(): SalesContact {
  const whatsapp = process.env.SALES_WHATSAPP?.replace(/\D/g, '') || null
  const email = process.env.SALES_EMAIL?.trim() || null
  return { whatsapp, email }
}

/**
 * The agency's own subscription: the agency plan it pays the platform for,
 * with the organization-level limits (clients, team members). Each client's
 * business plan lives on the client's pages and in Billing.
 *
 * A direct business has no organization subscription: it sees its one
 * client's business plan here, which it pays the platform for.
 */
export default async function SubscriptionPage({ params }: PageProps<'/[locale]/dashboard/subscription'>) {
  const { locale } = await params
  const { supabase, profile } = await getSession()
  if (!profile) redirect(`/${locale}/login`)
  // Billing is for the organization's admins
  if (!isOrgAdmin(profile.role)) redirect(`/${locale}/dashboard`)

  const t = await getTranslations('subscription')
  const context = await getClientContext()
  if (context?.orgType === 'direct') {
    const client = context.selected
    return client ? <DirectSubscription clientId={client.id} clientName={client.name} /> : <NoSubscription />
  }

  const details = await getSubscription()

  if (!details) return <NoSubscription />

  const [plans, invoices, org] = await Promise.all([
    getAvailablePlans('agency'),
    getInvoices(),
    supabase.from('organizations').select('name').eq('id', details.subscription.organization_id).maybeSingle<{ name: string }>(),
  ])

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <CurrentPlanCard details={details} />

      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
          <div className="flex items-start gap-3">
            <Wallet className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
            <div>
              <p className="font-medium">{t('clientsBilling.title')}</p>
              <p className="text-sm text-muted-foreground">{t('clientsBilling.description')}</p>
            </div>
          </div>
          <Button asChild variant="outline">
            <Link href="/dashboard/billing">
              {t('clientsBilling.open')}
              <ArrowRight className="rtl:rotate-180" />
            </Link>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('usage.title')}</CardTitle>
          <CardDescription>{t('usage.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UsageBars usage={details.usage} />
        </CardContent>
      </Card>

      <section className="grid gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t('upgrade.title')}</h2>
          <p className="text-muted-foreground mt-1">{t('upgrade.description')}</p>
        </div>
        <PlanPicker
          plans={plans}
          currentPlanId={details.plan.id}
          organizationName={org.data?.name ?? ''}
          contact={salesContact()}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t('invoices.title')}</CardTitle>
          <CardDescription>{t('invoices.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <InvoicesTable invoices={invoices} />
        </CardContent>
      </Card>
    </div>
  )
}

async function NoSubscription() {
  const t = await getTranslations('subscription')
  return (
    <div className="p-8">
      <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
      <p className="text-muted-foreground mt-4">{t('none')}</p>
    </div>
  )
}

/** Plan changes go through sales: the business pays the platform, not an agency. */
async function DirectSubscription({ clientId, clientName }: { clientId: string; clientName: string }) {
  const t = await getTranslations('subscription')
  const [details, plans, invoices] = await Promise.all([
    getClientSubscription(clientId),
    getClientAvailablePlans(clientId),
    getClientInvoices(clientId),
  ])
  if (!details) return <NoSubscription />

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('direct.description')}</p>
      </div>

      <CurrentPlanCard details={details} />

      <Card>
        <CardHeader>
          <CardTitle>{t('usage.title')}</CardTitle>
          <CardDescription>{t('direct.usage')}</CardDescription>
        </CardHeader>
        <CardContent>
          <UsageBars usage={details.usage} />
        </CardContent>
      </Card>

      <section className="grid gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">{t('upgrade.title')}</h2>
          <p className="text-muted-foreground mt-1">{t('upgrade.description')}</p>
        </div>
        <PlanPicker
          plans={plans}
          currentPlanId={details.plan.id}
          organizationName={clientName}
          contact={salesContact()}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t('invoices.title')}</CardTitle>
          <CardDescription>{t('direct.invoices')}</CardDescription>
        </CardHeader>
        <CardContent>
          <InvoicesTable invoices={invoices} />
        </CardContent>
      </Card>
    </div>
  )
}
