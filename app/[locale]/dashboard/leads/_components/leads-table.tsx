'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, Loader2, UserRoundSearch } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChannelIcon } from '@/components/channel-icon'
import { RelativeTime } from '@/components/relative-time'
import { bulkUpdateLeadStatus, exportLeads } from '@/lib/actions/leads'
import { LEAD_STATUSES, type LeadFilters, type LeadListItem, type LeadStatus } from '@/lib/types/leads'
import { LeadStatusBadge } from './lead-status-badge'

const LIST_LIMIT = 200

function downloadCsv(csv: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

export function LeadsTable({
  leads,
  filters,
  hasFilters,
}: {
  leads: LeadListItem[]
  filters: LeadFilters
  hasFilters: boolean
}) {
  const t = useTranslations('leads')
  const format = useFormatter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkStatus, setBulkStatus] = useState<LeadStatus | ''>('')
  const [isUpdating, startUpdating] = useTransition()
  const [isExporting, startExporting] = useTransition()

  const allSelected = leads.length > 0 && selected.size === leads.length
  const someSelected = selected.size > 0 && !allSelected

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function applyBulk() {
    if (!bulkStatus || selected.size === 0) return
    startUpdating(async () => {
      const result = await bulkUpdateLeadStatus([...selected], bulkStatus)
      if (result.ok) {
        toast.success(t('toast.bulkUpdated', { count: result.updated ?? selected.size }))
        setSelected(new Set())
        setBulkStatus('')
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  function handleExport() {
    startExporting(async () => {
      const result = await exportLeads(filters)
      if (!result.ok) {
        toast.error(t(`errors.${result.error}`))
        return
      }
      downloadCsv(result.csv, `leads-${new Date().toISOString().slice(0, 10)}.csv`)
    })
  }

  return (
    <Card className="mt-4 py-0">
      <CardContent className="px-0">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
          {selected.size > 0 ? (
            <>
              <span className="text-sm font-medium">{t('bulk.selected', { count: selected.size })}</span>
              <Select value={bulkStatus} onValueChange={(v) => setBulkStatus(v as LeadStatus)}>
                <SelectTrigger className="w-48" aria-label={t('bulk.changeStatus')}>
                  <SelectValue placeholder={t('bulk.changeStatus')} />
                </SelectTrigger>
                <SelectContent>
                  {LEAD_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(`status.${status}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" onClick={applyBulk} disabled={!bulkStatus || isUpdating}>
                {isUpdating && <Loader2 data-icon="inline-start" className="animate-spin" />}
                {t('bulk.apply')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                {t('bulk.clear')}
              </Button>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">{t('count', { count: leads.length })}</span>
          )}
          <Button
            size="sm"
            variant="outline"
            className="ms-auto"
            onClick={handleExport}
            disabled={isExporting || leads.length === 0}
          >
            {isExporting ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <Download data-icon="inline-start" />
            )}
            {t('export')}
          </Button>
        </div>

        {leads.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
            <UserRoundSearch className="size-8" />
            {hasFilters ? t('emptyFiltered') : t('empty')}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 ps-4">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(checked) =>
                      setSelected(checked === true ? new Set(leads.map((lead) => lead.id)) : new Set())
                    }
                    aria-label={t('bulk.selectAll')}
                  />
                </TableHead>
                <TableHead>{t('fields.name')}</TableHead>
                <TableHead>{t('fields.phone')}</TableHead>
                <TableHead>{t('fields.service')}</TableHead>
                <TableHead>{t('fields.client')}</TableHead>
                <TableHead>{t('fields.status')}</TableHead>
                <TableHead>{t('fields.createdAt')}</TableHead>
                <TableHead>{t('fields.lastContacted')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map((lead) => (
                <TableRow key={lead.id} data-state={selected.has(lead.id) ? 'selected' : undefined}>
                  <TableCell className="ps-4">
                    <Checkbox
                      checked={selected.has(lead.id)}
                      onCheckedChange={(checked) => toggle(lead.id, checked === true)}
                      aria-label={t('bulk.select', { name: lead.name ?? lead.phone ?? '' })}
                    />
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/dashboard/leads/${lead.id}`}
                      className="inline-flex items-center gap-1.5 font-medium hover:underline"
                    >
                      {lead.conversation?.channel && (
                        <ChannelIcon type={lead.conversation.channel.type} className="size-3.5 text-muted-foreground" />
                      )}
                      {lead.name || t('unnamed')}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span dir="ltr" className="font-mono text-sm">
                      {lead.phone ?? '—'}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-56 truncate" title={lead.service_requested ?? undefined}>
                    {lead.service_requested || '—'}
                  </TableCell>
                  <TableCell>{lead.client.name}</TableCell>
                  <TableCell>
                    <LeadStatusBadge status={lead.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format.dateTime(new Date(lead.created_at), { dateStyle: 'medium' })}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {lead.last_contacted_at ? <RelativeTime date={lead.last_contacted_at} /> : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {leads.length >= LIST_LIMIT && (
          <p className="border-t py-3 text-center text-xs text-muted-foreground">{t('limitNotice')}</p>
        )}
      </CardContent>
    </Card>
  )
}
