'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { BarChart3, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export type ChartTable = { headers: string[]; rows: (string | number)[][] }

/**
 * A chart with its table-view twin (every value readable without hovering or
 * relying on color) and an empty state instead of a blank plot.
 */
export function ChartCard({
  title,
  description,
  table,
  empty,
  className,
  children,
}: {
  title: string
  description?: string
  table: ChartTable
  empty: boolean
  className?: string
  children: React.ReactNode
}) {
  const t = useTranslations('analytics')
  const [asTable, setAsTable] = useState(false)

  return (
    <Card className={cn('break-inside-avoid', className)}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {!empty && (
          <CardAction className="print:hidden">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAsTable((v) => !v)}
              aria-pressed={asTable}
            >
              {asTable ? <BarChart3 data-icon="inline-start" /> : <Table2 data-icon="inline-start" />}
              {asTable ? t('viewChart') : t('viewTable')}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <BarChart3 className="size-8" />
            {t('noData')}
          </div>
        ) : asTable ? (
          <div className="max-h-80 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  {table.headers.map((header) => (
                    <th key={header} className="py-2 text-start font-medium">
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {table.rows.map((row, i) => (
                  <tr key={i} className="border-b last:border-0">
                    {row.map((cell, j) => (
                      <td key={j} className="py-1.5">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}
