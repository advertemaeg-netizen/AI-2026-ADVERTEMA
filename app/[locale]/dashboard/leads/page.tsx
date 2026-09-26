import { getTranslations } from 'next-intl/server'
import { getLeads } from '@/lib/actions/leads'
import { getClients } from '@/lib/actions/clients'
import { parseListFilters } from '@/lib/list-filters'
import { getSelectedClient } from '@/lib/auth/client-context'
import { LEAD_STATUSES } from '@/lib/types/leads'
import { ListFiltersBar } from '@/components/list-filters-bar'
import { LeadsTable } from './_components/leads-table'

export default async function LeadsPage({ searchParams }: PageProps<'/[locale]/dashboard/leads'>) {
  const filters = parseListFilters(await searchParams, LEAD_STATUSES)
  // Scoped to the client picked in the sidebar switcher, if any
  const selectedClient = await getSelectedClient()
  if (selectedClient) filters.clientId = selectedClient.id
  const t = await getTranslations('leads')
  const [leads, clients] = await Promise.all([getLeads(filters), getClients()])

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <ListFiltersBar
        namespace="leads"
        statuses={LEAD_STATUSES}
        filters={filters}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
        clientLocked={!!selectedClient}
      />

      <LeadsTable
        // Reset selection whenever the result set changes
        key={JSON.stringify(filters)}
        leads={leads}
        filters={filters}
        hasFilters={Object.entries(filters).some(([key, value]) => value && !(key === 'clientId' && selectedClient))}
      />
    </div>
  )
}
