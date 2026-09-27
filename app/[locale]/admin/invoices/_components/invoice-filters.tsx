'use client'

import { useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { INVOICE_STATUSES, type InvoiceStatus } from '@/lib/types/subscription'

const ALL = 'all'

export function InvoiceFilters({
  organizations,
  filters,
}: {
  organizations: { id: string; name: string }[]
  filters: { status?: InvoiceStatus; organizationId?: string }
}) {
  const t = useTranslations('invoices')
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  function update(key: 'status' | 'org', value: string) {
    const next = { status: filters.status, org: filters.organizationId, [key]: value === ALL ? undefined : value }
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v)
    const qs = params.toString()
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={filters.status ?? ALL} onValueChange={(v) => update('status', v)}>
        <SelectTrigger className="w-44" aria-label={t('filters.status')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>
          {INVOICE_STATUSES.map((status) => (
            <SelectItem key={status} value={status}>
              {t(`status.${status}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={filters.organizationId ?? ALL} onValueChange={(v) => update('org', v)}>
        <SelectTrigger className="w-56" aria-label={t('filters.organization')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{t('filters.allOrganizations')}</SelectItem>
          {organizations.map((org) => (
            <SelectItem key={org.id} value={org.id}>
              {org.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </div>
  )
}
