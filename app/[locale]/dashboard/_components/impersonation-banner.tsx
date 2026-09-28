'use client'

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, Eye, Loader2 } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { endImpersonation } from '@/lib/actions/impersonation'

/** Always on top while a super admin views a customer's account; there's no closing it, only leaving. */
export function ImpersonationBanner({ organizationName }: { organizationName: string }) {
  const t = useTranslations('impersonation')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  function exit() {
    startTransition(async () => {
      const result = await endImpersonation()
      if (!result.ok) {
        toast.error(t('errors.unknown'))
        return
      }
      router.push('/admin')
      router.refresh()
    })
  }

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-destructive px-4 py-2 text-sm font-medium text-white print:hidden"
    >
      <Eye className="size-4 shrink-0" aria-hidden />
      <span>
        {t('banner', { organization: organizationName })}
        <span className="opacity-80"> · {t('readOnlyHint')}</span>
      </span>
      <span aria-hidden>—</span>
      <button
        type="button"
        onClick={exit}
        disabled={isPending}
        className="inline-flex items-center gap-1 underline underline-offset-4 hover:no-underline disabled:opacity-70"
      >
        {isPending ? <Loader2 className="size-4 animate-spin" /> : <ArrowLeft className="size-4 rtl:rotate-180" />}
        {t('exit')}
      </button>
    </div>
  )
}
