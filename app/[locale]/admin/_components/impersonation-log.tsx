import { getFormatter, getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { durationParts } from '@/lib/format-duration'
import type { ImpersonationLogEntry } from '@/lib/types/impersonation'

/** Who opened which customer's account, for how long, and how many support actions they took. */
export async function ImpersonationLog({ entries }: { entries: ImpersonationLogEntry[] }) {
  const t = await getTranslations('impersonation.log')
  const tDuration = await getTranslations('analytics.duration')
  const tTypes = await getTranslations('admin.customers.type')
  const format = await getFormatter()

  function duration(entry: ImpersonationLogEntry) {
    if (!entry.ended_at) return <Badge variant="destructive">{t('active')}</Badge>
    const seconds = (Date.parse(entry.ended_at) - Date.parse(entry.started_at)) / 1000
    if (seconds < 60) return t('lessThanMinute')
    const { value, unit } = durationParts(seconds)
    return tDuration(unit, { value: format.number(value) })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.customer')}</TableHead>
                <TableHead>{t('columns.admin')}</TableHead>
                <TableHead>{t('columns.startedAt')}</TableHead>
                <TableHead>{t('columns.duration')}</TableHead>
                <TableHead className="text-end">{t('columns.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>
                    <Link href={`/admin/customers/${entry.organization_id}`} className="font-medium hover:underline">
                      {entry.organization_name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{tTypes(entry.org_type)}</div>
                  </TableCell>
                  <TableCell>
                    <div>{entry.admin_name || entry.admin_email}</div>
                    {entry.admin_name && (
                      <div className="text-xs text-muted-foreground" dir="ltr">
                        {entry.admin_email}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format.dateTime(new Date(entry.started_at), { dateStyle: 'medium', timeStyle: 'short' })}
                  </TableCell>
                  <TableCell>{duration(entry)}</TableCell>
                  <TableCell className="text-end tabular-nums">{format.number(entry.actions_count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
