import { ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getClientContext } from '@/lib/auth/client-context'
import { ClientSubnav } from './client-subnav'

// A direct business has no clients list, and the sidebar already lists its
// one client's pages — so neither the way back nor the tabs apply to it.

export async function BackToClients({ label }: { label: string }) {
  if ((await getClientContext())?.orgType === 'direct') return null
  return (
    <Link
      href="/dashboard/clients"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="size-4 rtl:rotate-180" />
      {label}
    </Link>
  )
}

export async function ClientTabs({ clientId }: { clientId: string }) {
  if ((await getClientContext())?.orgType === 'direct') return null
  return <ClientSubnav clientId={clientId} />
}
