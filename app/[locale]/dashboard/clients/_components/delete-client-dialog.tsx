'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
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
import { deleteClientAction } from '@/lib/actions/clients'
import type { Client } from '@/lib/types/clients'

export function DeleteClientDialog({
  client,
  open,
  onOpenChange,
}: {
  client: Client
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const [isPending, startTransition] = useTransition()

  function handleDelete(e: React.MouseEvent) {
    // Keep the dialog open until the server responds
    e.preventDefault()

    startTransition(async () => {
      const result = await deleteClientAction(client.id)
      if (result.ok) {
        toast.success(t('toast.deleted'))
        onOpenChange(false)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('deleteDescription', { name: client.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={isPending}>
            {isPending ? tCommon('loading') : tCommon('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
