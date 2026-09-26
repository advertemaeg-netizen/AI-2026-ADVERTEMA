import { getTranslations } from 'next-intl/server'
import { getUpcomingAppointments } from '@/lib/actions/appointments'
import { getSelectedClient } from '@/lib/auth/client-context'
import { APPOINTMENT_RANGES, type AppointmentRange } from '@/lib/types/appointments'
import { AppointmentsView } from './_components/appointments-view'

export default async function AppointmentsPage({
  searchParams,
}: PageProps<'/[locale]/dashboard/appointments'>) {
  const params = await searchParams
  const range: AppointmentRange = APPOINTMENT_RANGES.includes(params.range as AppointmentRange)
    ? (params.range as AppointmentRange)
    : 'today'

  const t = await getTranslations('appointments')
  // Scoped to the client picked in the sidebar switcher, if any
  const selectedClient = await getSelectedClient()
  const appointments = await getUpcomingAppointments({ range, clientId: selectedClient?.id ?? null })

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <AppointmentsView
        // Fresh local state (open dialogs etc.) per tab
        key={range}
        range={range}
        appointments={appointments}
        showClient={!selectedClient}
      />
    </div>
  )
}
