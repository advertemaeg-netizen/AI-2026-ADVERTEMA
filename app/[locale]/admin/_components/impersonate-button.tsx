'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Eye, Loader2 } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { startImpersonation } from '@/lib/actions/impersonation'

/** Opens the customer's dashboard, read-only, as a super admin. */
export function ImpersonateButton({
  organizationId,
  organizationName,
  size = 'sm',
}: {
  organizationId: string
  organizationName: string
  size?: 'sm' | 'default'
}) {
  const t = useTranslations('impersonation')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function enter(e: React.MouseEvent) {
    // Rows open the customer's page on click
    e.stopPropagation()
    startTransition(async () => {
      const result = await startImpersonation(organizationId)
      if (!result.ok) {
        toast.error(t(`errors.${result.error}`))
        return
      }
      router.push('/dashboard')
      router.refresh()
    })
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={enter}
      disabled={isPending}
      aria-label={t('enterLabel', { name: organizationName })}
    >
      {isPending ? <Loader2 className="animate-spin" /> : <Eye />}
      {t('enter')}
    </Button>
  )
}
