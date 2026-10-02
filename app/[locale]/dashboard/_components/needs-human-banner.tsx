'use client'

import { useTranslations } from 'next-intl'
import { MessageSquareWarning } from 'lucide-react'
import { Link, usePathname } from '@/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * Conversations the assistant could not answer (the AI call failed and the
 * visitor got the fallback message): someone on the team has to reply.
 */
export function NeedsHumanBanner({ count }: { count: number }) {
  const t = useTranslations('conversations')
  // On a phone, inside a conversation, the screen belongs to the messages
  const inThread = /^\/dashboard\/conversations\/[^/]+$/.test(usePathname())
  if (count === 0) return null

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b border-destructive/40 bg-destructive/10 px-8 py-3 text-sm text-destructive print:hidden max-md:px-4 max-md:py-2',
        inThread && 'max-md:hidden'
      )}
    >
      <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden />
      <p className="flex-1">
        <span className="font-medium">{t('needsHumanBanner', { count })}</span>{' '}
        <Link href="/dashboard/conversations" className="underline underline-offset-4">
          {t('needsHumanOpen')}
        </Link>
      </p>
    </div>
  )
}
