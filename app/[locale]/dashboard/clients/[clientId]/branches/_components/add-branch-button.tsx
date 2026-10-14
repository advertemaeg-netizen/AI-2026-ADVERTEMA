'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { BranchFormDialog } from './branch-form-dialog'

export function AddBranchButton({ clientId }: { clientId: string }) {
  const t = useTranslations('branches')
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" />
        {t('add')}
      </Button>
      {/* Keyed on opening: each opening starts from an empty form */}
      <BranchFormDialog key={open ? 'open' : 'closed'} clientId={clientId} open={open} onOpenChange={setOpen} />
    </>
  )
}
