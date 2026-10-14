'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MapPin, Pencil, Trash2, TriangleAlert, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { deleteBranchAction, deleteClosureAction } from '@/lib/actions/branches'
import { WEEK_DAYS } from '@/lib/types/bot-settings'
import type { Branch } from '@/lib/types/branches'
import { BranchFormDialog } from './branch-form-dialog'
import { ClosureDialog } from './closure-dialog'

export function BranchCard({
  clientId,
  branch,
  branches,
}: {
  clientId: string
  branch: Branch
  branches: Pick<Branch, 'id' | 'name'>[]
}) {
  const t = useTranslations('branches')
  const tDays = useTranslations('botSettings')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [isDeleting, startDelete] = useTransition()
  const [removing, startRemove] = useTransition()

  function handleDelete(e: React.MouseEvent) {
    // Keep the dialog open until the server responds
    e.preventDefault()
    startDelete(async () => {
      const result = await deleteBranchAction(branch.id)
      if (result.ok) {
        toast.success(t('toast.deleted'))
        setDeleteOpen(false)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  function removeClosure(id: string) {
    startRemove(async () => {
      const result = await deleteClosureAction(id)
      if (result.ok) toast.success(t('toast.closureDeleted'))
      else toast.error(t(`errors.${result.error}`))
    })
  }

  const todayThere = new Intl.DateTimeFormat('en-CA', { timeZone: branch.timezone }).format(new Date())

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <MapPin className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{branch.name}</CardTitle>
            <CardDescription>
              {t('fields.capacity')}: {branch.capacity_per_slot} · {t('slot', { minutes: branch.slot_minutes })} ·{' '}
              {t('leads', { count: branch.leadCount })}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={branch.is_active ? 'default' : 'secondary'}>
            {branch.is_active ? t('status.active') : t('status.inactive')}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-4">
        {!branch.is_active && branch.upcomingCount > 0 && (
          <p className="flex items-start gap-2 rounded-lg border border-warning-solid/40 bg-warning-solid/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            {t('inactiveUpcoming', { count: branch.upcomingCount })}
          </p>
        )}

        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{t('hours.title')}</p>
          {branch.business_hours === null ? (
            // Not a quiet grey line: a branch without hours confirms nothing,
            // and every new client starts with one
            <div className="flex flex-wrap items-start gap-3 rounded-lg border border-warning-solid/40 bg-warning-solid/10 p-3 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1">{t('hours.needed')}</p>
              <Button size="sm" onClick={() => setEditOpen(true)}>
                {t('hours.setNow')}
              </Button>
            </div>
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
              {WEEK_DAYS.map((day) => {
                const ranges = branch.business_hours![day]
                return (
                  <div key={day} className="contents">
                    <dt className="text-muted-foreground">{tDays(`days.${day}`)}</dt>
                    <dd dir={ranges.length ? 'ltr' : undefined} className="text-start">
                      {ranges.length ? ranges.map(([from, to]) => `${from}–${to}`).join(' · ') : t('hours.closed')}
                    </dd>
                  </div>
                )
              })}
            </dl>
          )}
        </div>

        <div className="grid gap-1.5">
          <p className="text-sm font-medium">{t('closures.title')}</p>
          {branch.closures.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('closures.empty')}</p>
          ) : (
            <ul className="grid gap-1">
              {branch.closures.map((closure) => (
                <li key={closure.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className={closure.date < todayThere ? 'text-muted-foreground' : undefined}>
                    {format.dateTime(new Date(`${closure.date}T00:00:00Z`), { dateStyle: 'full', timeZone: 'UTC' })}
                    {closure.reason && ` — ${closure.reason}`}
                    {closure.date < todayThere && ` (${t('closures.past')})`}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('closures.delete')}
                    disabled={removing}
                    onClick={() => removeClosure(closure.id)}
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            <Pencil data-icon="inline-start" />
            {t('edit')}
          </Button>
          <ClosureDialog clientId={clientId} branch={branch} branches={branches} />

          <AlertDialog open={deleteOpen} onOpenChange={(next) => !isDeleting && setDeleteOpen(next)}>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="ms-auto text-destructive hover:text-destructive">
                <Trash2 data-icon="inline-start" />
                {t('delete')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('deleteTitle', { name: branch.name })}</AlertDialogTitle>
                <AlertDialogDescription>
                  {branch.leadCount > 0 ? t('deleteBlocked', { count: branch.leadCount }) : t('deleteDescription')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={isDeleting}>{tCommon('cancel')}</AlertDialogCancel>
                {branch.leadCount === 0 && (
                  <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={isDeleting}>
                    {isDeleting ? tCommon('loading') : t('delete')}
                  </AlertDialogAction>
                )}
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </CardContent>

      {/* Keyed on opening: each opening starts from the branch as it is saved */}
      <BranchFormDialog
        key={editOpen ? 'open' : 'closed'}
        clientId={clientId}
        branch={branch}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
    </Card>
  )
}
