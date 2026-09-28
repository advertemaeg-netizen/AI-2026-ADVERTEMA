'use client'

import { useEffect, useState, useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, ArrowUpDown, Building2, Loader2, Search } from 'lucide-react'
import { useRouter as useLocaleRouter } from '@/i18n/navigation'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RelativeTime } from '@/components/relative-time'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { OrgListParams } from '@/lib/admin-list'
import { ORG_STATUS_FILTERS, ORG_TYPES, type OrganizationOverview, type OrgSortKey } from '@/lib/types/admin'
import { ImpersonateButton } from './impersonate-button'

const ALL = 'all'

const COLUMNS: { key: OrgSortKey; numeric?: boolean }[] = [
  { key: 'name' },
  { key: 'clients', numeric: true },
  { key: 'users', numeric: true },
  { key: 'conversations', numeric: true },
  { key: 'leads', numeric: true },
  { key: 'createdAt' },
  { key: 'lastActivityAt' },
]

/**
 * Customers (organizations: agencies and direct businesses) with search and
 * sortable columns, plus (optionally) type tabs and a status filter, all kept
 * in the URL.
 */
export function CustomersTable({
  organizations,
  params,
  showFilters = false,
}: {
  organizations: OrganizationOverview[]
  params: OrgListParams
  showFilters?: boolean
}) {
  const t = useTranslations('admin.customers')
  const format = useFormatter()
  const router = useRouter()
  const localeRouter = useLocaleRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()
  const [search, setSearch] = useState(params.q ?? '')

  function update(next: Partial<Record<'q' | 'sort' | 'dir' | 'status' | 'type', string | undefined>>) {
    const merged = {
      q: params.q,
      sort: params.sort.key,
      dir: params.sort.dir,
      status: params.status,
      type: params.type,
      ...next,
    }
    const query = new URLSearchParams()
    for (const [k, v] of Object.entries(merged)) if (v) query.set(k, v)
    const qs = query.toString()
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  function sortBy(key: OrgSortKey) {
    // Names read A→Z first; numbers and dates biggest / newest first
    const dir =
      params.sort.key === key ? (params.sort.dir === 'asc' ? 'desc' : 'asc') : key === 'name' ? 'asc' : 'desc'
    update({ sort: key, dir })
  }

  // Debounce typing into the URL
  useEffect(() => {
    const value = search.trim() || undefined
    if (value === params.q) return
    const timer = setTimeout(() => update({ q: value }), 350)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the text changes
  }, [search])

  return (
    <div className="grid gap-4">
      {showFilters && (
        <Tabs
          value={params.type ?? ALL}
          onValueChange={(value) => update({ type: value === ALL ? undefined : value })}
        >
          <TabsList>
            {[...ORG_TYPES, ALL].map((type) => (
              <TabsTrigger key={type} value={type}>
                {t(`tabs.${type}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
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
        {showFilters && (
          <Select
            value={params.status ?? ALL}
            onValueChange={(value) => update({ status: value === ALL ? undefined : value })}
          >
            <SelectTrigger className="w-40" aria-label={t('statusFilter')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('status.all')}</SelectItem>
              {ORG_STATUS_FILTERS.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`status.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {organizations.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
          <Building2 className="size-8" />
          {params.q || params.status || params.type ? t('noMatches') : t('empty')}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              {COLUMNS.map(({ key, numeric }, index) => {
                const active = params.sort.key === key
                const Icon = active ? (params.sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown
                const head = (
                  <TableHead
                    key={key}
                    className={cn(numeric && 'text-end')}
                    aria-sort={active ? (params.sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => sortBy(key)}
                      className={cn(
                        'inline-flex items-center gap-1 hover:text-foreground',
                        active ? 'text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      {t(`columns.${key}`)}
                      <Icon className="size-3.5" aria-hidden />
                    </button>
                  </TableHead>
                )
                // The type column (not sortable) sits right after the name
                return index === 0 ? [head, <TableHead key="type">{t('columns.type')}</TableHead>] : head
              })}
              <TableHead>
                <span className="sr-only">{t('columns.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organizations.map((org) => (
              <TableRow
                key={org.id}
                className="cursor-pointer"
                onClick={() => localeRouter.push(`/admin/customers/${org.id}`)}
              >
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/admin/customers/${org.id}`}
                      className="font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {org.name}
                    </Link>
                    {!org.isActive && <Badge variant="destructive">{t('status.disabled')}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground" dir="ltr">
                    {org.slug}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={org.orgType === 'direct' ? 'secondary' : 'outline'}>{t(`type.${org.orgType}`)}</Badge>
                </TableCell>
                <TableCell className="text-end tabular-nums">{format.number(org.clients)}</TableCell>
                <TableCell className="text-end tabular-nums">{format.number(org.users)}</TableCell>
                <TableCell className="text-end tabular-nums">{format.number(org.conversations)}</TableCell>
                <TableCell className="text-end tabular-nums">{format.number(org.leads)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {format.dateTime(new Date(org.createdAt), { dateStyle: 'medium' })}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {org.lastActivityAt ? <RelativeTime date={org.lastActivityAt} /> : t('noActivity')}
                </TableCell>
                <TableCell className="text-end">
                  <ImpersonateButton organizationId={org.id} organizationName={org.name} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}
