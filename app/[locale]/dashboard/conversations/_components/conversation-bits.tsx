import { useTranslations } from 'next-intl'
import { UserRound } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { ChannelIcon } from '@/components/channel-icon'
import { cn } from '@/lib/utils'
import type { ChannelType } from '@/lib/types/channels'
import type { ConversationStatus } from '@/lib/types/conversations'

const STATUS_STYLES: Record<ConversationStatus, string> = {
  new: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  in_progress: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  converted: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  closed: 'bg-muted text-muted-foreground',
}

export function StatusBadge({ status }: { status: ConversationStatus }) {
  const t = useTranslations('conversations')
  return (
    <Badge variant="secondary" className={STATUS_STYLES[status]}>
      {t(`status.${status}`)}
    </Badge>
  )
}

/** Visitor name, or a short stable label built from their anonymous id. */
export function useContactLabel() {
  const t = useTranslations('conversations')
  return (contact: { contact_name: string | null; contact_identifier: string | null }) =>
    contact.contact_name ||
    t('visitor', { id: (contact.contact_identifier ?? '').slice(0, 6).toUpperCase() || '—' })
}

export function ContactAvatar({
  name,
  channelType,
  className,
}: {
  name: string | null
  channelType: ChannelType
  className?: string
}) {
  const initials = name
    ?.split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <div className={cn('relative shrink-0', className)}>
      <Avatar>
        <AvatarFallback className="text-xs">
          {initials || <UserRound className="size-4" />}
        </AvatarFallback>
      </Avatar>
      <span className="absolute -bottom-1 -end-1 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground">
        <ChannelIcon type={channelType} className="size-3" />
      </span>
    </div>
  )
}
