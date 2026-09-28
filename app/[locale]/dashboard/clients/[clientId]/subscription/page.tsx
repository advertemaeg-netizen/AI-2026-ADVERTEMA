import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { AlertTriangle } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CurrentPlanCard } from '@/components/billing/current-plan-card'
import { CreateInvoiceDialog } from '@/components/billing/create-invoice-dialog'
import { InvoicesTable } from '@/components/billing/invoices-table'
import { UsageBars } from '@/components/billing/usage-bars'
import { getSession } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { getClient } from '@/lib/actions/clients'
import { getClientAvailablePlans, getClientInvoices, getClientSubscription } from '@/lib/actions/client-subscription'
import { redirectDirectBusiness, requireClientManager } from '@/lib/auth/guards'
import { BackToClients, ClientTabs } from '../_components/client-page-nav'
import { ClientPlanPicker } from '@/components/billing/client-plan-picker'
import { ClientPricingActions } from '@/components/billing/client-pricing-actions'

/**
 * One client's business plan, paid to the agency. Agency admins change the
 * plan, set a custom price and bill the client; the client's own admins see
 * everything read-only.
 */
export default async function ClientSubscriptionPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/subscription'>) {
  const { locale, clientId } = await params
  // A direct business pays the platform: its plan is on /dashboard/subscription
  await redirectDirectBusiness(locale, '/dashboard/subscription')
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const [client, { profile }] = await Promise.all([getClient(clientId), getSession()])
  if (!client || !profile) notFound()

  const t = await getTranslations('clientSubscription')
  const canManageBilling = isOrgAdmin(profile.role)
  const details = await getClientSubscription(clientId)

  const header = (
    <>
      <BackToClients label={t('backToClients')} />
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight max-md:text-2xl">{t('title', { client: client.name })}</h1>
        <p className="text-muted-foreground mt-1">{t(canManageBilling ? 'description' : 'descriptionReadOnly')}</p>
      </div>
      <ClientTabs clientId={clientId} />
    </>
  )

  if (!details) {
    return (
      <div className="p-8 max-md:p-4">
        {header}
        <p className="text-muted-foreground">{t('none')}</p>
      </div>
    )
  }

  const [plans, invoices] = await Promise.all([getClientAvailablePlans(clientId), getClientInvoices(clientId)])
  const { subscription, plan, custom_pricing: custom } = details

  return (
    <div className="p-8 max-md:p-4">
      {header}

      <div className="grid gap-6">
        {!subscription.agency_usable && (
          <p
            role="status"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            {t(canManageBilling ? 'agencyInactive' : 'agencyInactiveClient')}
          </p>
        )}

        <div className="grid gap-3">
          {canManageBilling && (
            <div className="flex justify-end">
              <ClientPricingActions
                clientId={clientId}
                clientName={client.name}
                basePrice={plan.price_monthly}
                hasCustomPricing={!!custom}
              />
            </div>
          )}
          <CurrentPlanCard
            details={details}
            title={t('currentPlan')}
            inactiveNotice={t(canManageBilling ? 'inactive' : 'inactiveClient')}
          />
          {custom && !custom.applies && canManageBilling && (
            <p className="text-sm text-amber-700 dark:text-amber-400">{t('pricing.notApplied')}</p>
          )}
        </div>

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
            <h2 className="text-2xl font-semibold tracking-tight">{t('plans.title')}</h2>
            <p className="text-muted-foreground mt-1">
              {t(canManageBilling ? 'plans.description' : 'plans.descriptionReadOnly')}
            </p>
          </div>
          <ClientPlanPicker
            clientId={clientId}
            clientName={client.name}
            plans={plans}
            currentPlanId={plan.id}
            canChange={canManageBilling}
          />
        </section>

        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
            <div className="grid gap-1">
              <CardTitle>{t('invoices.title')}</CardTitle>
              <CardDescription>{t('invoices.description')}</CardDescription>
            </div>
            {canManageBilling && <CreateInvoiceDialog billedTo="agency" parties={[]} partyId={clientId} />}
          </CardHeader>
          <CardContent>
            <InvoicesTable invoices={invoices} actions={canManageBilling ? 'agency' : undefined} />
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
