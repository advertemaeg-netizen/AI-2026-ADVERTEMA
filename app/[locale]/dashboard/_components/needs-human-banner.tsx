'use client'

import { useTranslations } from 'next-intl'
import { MessageSquareWarning } from 'lucide-react'
import { Link, usePathname } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { NEEDS_HUMAN_REASONS, type NeedsHumanReason } from '@/lib/types/conversations'

/**
 * Conversations where the visitor got no real answer, by cause. Each cause
 * is a different job for the client (reply and wait for us, upgrade, pay, add
 * content), so each gets its own line.
 */
export function NeedsHumanBanner({ counts }: { counts: Partial<Record<NeedsHumanReason, number>> }) {
  const t = useTranslations('conversations.needsHuman')
  // On a phone, inside a conversation, the screen belongs to the messages
  const inThread = /^\/dashboard\/conversations\/[^/]+$/.test(usePathname())
  const reasons = NEEDS_HUMAN_REASONS.filter((reason) => (counts[reason] ?? 0) > 0)
  if (reasons.length === 0) return null

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 border-b border-destructive/40 bg-destructive/10 px-8 py-3 text-sm text-destructive print:hidden max-md:px-4 max-md:py-2',
        inThread && 'max-md:hidden'
      )}
    >
      <MessageSquareWarning className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="grid flex-1 gap-0.5">
        {reasons.map((reason) => (
          <p key={reason}>
            <span className="font-medium">{t(`banner.${reason}`, { count: counts[reason]! })}</span>{' '}
            {t(`action.${reason}`)}
          </p>
        ))}
        <p>
          <Link href="/dashboard/conversations" className="underline underline-offset-4">
            {t('open')}
          </Link>
        </p>
      </div>
    </div>
  )
}
