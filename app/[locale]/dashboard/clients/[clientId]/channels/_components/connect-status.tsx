'use client'

import { useEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { usePathname, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CONNECT_STATUS_MESSAGES, CONNECT_SUCCESS, CONNECT_WARNING, type ConnectStatus } from '@/lib/types/meta-connect'

/**
 * How a Page and Instagram connect ended (?connect=<status>), shown once,
 * then dropped from the address so a refresh doesn't repeat it.
 */
export function ConnectStatusToast({ status }: { status: ConnectStatus }) {
  const t = useTranslations('channels')
  const router = useRouter()
  const pathname = usePathname()
  const shown = useRef(false)

  useEffect(() => {
    if (shown.current) return
    shown.current = true
    const message = t(CONNECT_STATUS_MESSAGES[status])
    if (CONNECT_SUCCESS.includes(status)) toast.success(message)
    else if (CONNECT_WARNING.includes(status)) toast.warning(message)
    else toast.error(message)
    router.replace(pathname)
  }, [status, t, router, pathname])

  return null
}
