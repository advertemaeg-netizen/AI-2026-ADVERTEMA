'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Building2, Layers } from 'lucide-react'
import { usePathname, useRouter } from '@/i18n/navigation'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { clientIdFromPath } from '@/components/client-sections'
import { setSelectedClient } from '@/lib/actions/client-context'
import type { ClientOption } from '@/lib/auth/client-context'

const ALL = 'all'

/**
 * Scopes the whole dashboard to one client (or all clients, for org admins).
 * On a client's own page, jumps to the same page of the newly picked client.
 */
export function ClientSwitcher({
  clients,
  selectedId,
  allowAll,
}: {
  clients: ClientOption[]
  selectedId: string | null
  allowAll: boolean
}) {
  const t = useTranslations('clientSwitcher')
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  function select(value: string) {
    const clientId = value === ALL ? null : value
    startTransition(async () => {
      const result = await setSelectedClient(clientId)
      if (!result.ok) {
        toast.error(t('error'))
        return
      }
      const current = clientIdFromPath(pathname)
      if (current && clientId) router.push(pathname.replace(current, clientId))
      else if (current) router.push('/dashboard/clients')
      else router.refresh()
    })
  }

  return (
    <Select value={selectedId ?? ALL} onValueChange={select} disabled={isPending}>
      <SelectTrigger className="w-full" aria-label={t('label')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowAll && (
          <>
            <SelectItem value={ALL}>
              <Layers />
              {t('allClients')}
            </SelectItem>
            {clients.length > 0 && <SelectSeparator />}
          </>
        )}
        {clients.map((client) => (
          <SelectItem key={client.id} value={client.id}>
            <Building2 />
            {client.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
