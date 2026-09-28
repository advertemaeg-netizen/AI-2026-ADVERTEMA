'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Ban, CircleCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toggleOrganizationActive } from '@/lib/actions/admin'

export function ToggleOrgButton({ orgId, name, isActive }: { orgId: string; name: string; isActive: boolean }) {
  const t = useTranslations('admin.details.toggle')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const mode = isActive ? 'disable' : 'enable'

  function confirm(e: React.MouseEvent) {
    // Keep the dialog open until the server responds
    e.preventDefault()
    startTransition(async () => {
      const result = await toggleOrganizationActive(orgId)
      if (result.ok) {
        toast.success(t(result.isActive ? 'enabled' : 'disabled', { name }))
        setOpen(false)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <>
      <Button variant={isActive ? 'destructive' : 'default'} onClick={() => setOpen(true)}>
        {isActive ? <Ban /> : <CircleCheck />}
        {t(`${mode}.button`)}
      </Button>
      <AlertDialog open={open} onOpenChange={(next) => !isPending && setOpen(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t(`${mode}.title`, { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t(`${mode}.description`)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant={isActive ? 'destructive' : 'default'}
              onClick={confirm}
              disabled={isPending}
            >
              {isPending ? tCommon('loading') : t(`${mode}.confirm`)}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
