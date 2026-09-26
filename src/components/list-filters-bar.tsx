'use client'

import { useEffect, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Loader2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChannelIcon } from '@/components/channel-icon'
import { CHANNEL_TYPES } from '@/lib/types/channels'
import { DATE_RANGES } from '@/lib/types/conversations'
import type { ListFilters } from '@/lib/list-filters'

const ALL = 'all'

type Filters = ListFilters<string>

// URL param names for each filter (read back by parseListFilters)
const PARAM: Record<keyof Filters, string> = {
  clientId: 'client',
  status: 'status',
  channelType: 'channel',
  range: 'range',
  q: 'q',
}

/**
 * Status tabs + search + client / channel / date filters, kept in the URL.
 * `namespace` must provide status.*, searchPlaceholder and filters.* keys.
 */
export function ListFiltersBar({
  filters,
  clients,
  statuses,
  namespace,
}: {
  filters: Filters
  clients: { id: string; name: string }[]
  statuses: readonly string[]
  namespace: 'conversations' | 'leads'
}) {
  const t = useTranslations(namespace)
  const tChannels = useTranslations('channels')
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()
  const [search, setSearch] = useState(filters.q ?? '')

  function update(key: keyof Filters, value: string | undefined) {
    const params = new URLSearchParams()
    const next = { ...filters, [key]: value }
    for (const [k, v] of Object.entries(next)) {
      if (v) params.set(PARAM[k as keyof Filters], v)
    }
    const query = params.toString()
    startTransition(() => router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false }))
  }

  // Debounce typing into the URL
  useEffect(() => {
    const value = search.trim() || undefined
    if (value === filters.q) return
    const timer = setTimeout(() => update('q', value), 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the text changes
  }, [search])

  return (
    <div className="grid gap-3">
      <Tabs
        value={filters.status ?? ALL}
        onValueChange={(value) => update('status', value === ALL ? undefined : value)}
      >
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value={ALL}>{t('status.all')}</TabsTrigger>
          {statuses.map((status) => (
            <TabsTrigger key={status} value={status}>
              {t(`status.${status}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
            className="ps-8"
          />
        </div>

        <Select
          value={filters.clientId ?? ALL}
          onValueChange={(value) => update('clientId', value === ALL ? undefined : value)}
        >
          <SelectTrigger className="w-44" aria-label={t('filters.client')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('filters.allClients')}</SelectItem>
            {clients.map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.channelType ?? ALL}
          onValueChange={(value) => update('channelType', value === ALL ? undefined : value)}
        >
          <SelectTrigger className="w-44" aria-label={t('filters.channel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('filters.allChannels')}</SelectItem>
            {CHANNEL_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                <ChannelIcon type={type} />
                {tChannels(`types.${type}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={filters.range ?? ALL}
          onValueChange={(value) => update('range', value === ALL ? undefined : value)}
        >
          <SelectTrigger className="w-40" aria-label={t('filters.date')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('filters.anyTime')}</SelectItem>
            {DATE_RANGES.map((range) => (
              <SelectItem key={range} value={range}>
                {t(`filters.ranges.${range}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
    </div>
  )
}
