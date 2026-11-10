import { useTranslations } from 'next-intl'
import { UserRound } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { StateBadge, type BadgeVariant } from '@/components/ui/badge'
import { ChannelIcon, type ChannelSurface } from '@/components/channel-icon'
import { cn } from '@/lib/utils'
import type { ChannelType } from '@/lib/types/channels'
import type { ConversationStatus } from '@/lib/types/conversations'

const STATUS_VARIANT: Record<ConversationStatus, BadgeVariant> = {
  new: 'info',
  in_progress: 'progress',
  converted: 'positive',
  closed: 'quiet',
}

export function StatusBadge({ status }: { status: ConversationStatus }) {
  const t = useTranslations('conversations')
  return (
    <StateBadge state={status} variant={STATUS_VARIANT[status]}>
      {t(`status.${status}`)}
    </StateBadge>
  )
}

/** Visitor name, or a short stable label built from their anonymous id. */
export function useContactLabel() {
  const t = useTranslations('conversations')
  return (contact: { contact_name: string | null; contact_identifier: string | null }) =>
    contact.contact_name ||
    t('visitor', { id: (contact.contact_identifier ?? '').slice(0, 6).toUpperCase() || '—' })
}

/** The channel's name for its glyph's tooltip, in the owner's words (channelNames): a private message's channel */
export function useChannelName() {
  const t = useTranslations('channelNames')
  return (type: ChannelType) => t(type)
}

export function ContactAvatar({
  name,
  channelType,
  surface = 'dm',
  channelLabel,
  className,
}: {
  name: string | null
  channelType: ChannelType
  /** A comment wears its platform's glyph (Facebook's, not Messenger's) */
  surface?: ChannelSurface
  /** The glyph's tooltip: the channel's name */
  channelLabel?: string
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
      <span
        title={channelLabel}
        className="absolute -bottom-1 -end-1 flex size-5 items-center justify-center rounded-full border bg-background"
      >
        <ChannelIcon type={channelType} surface={surface} className="size-3" />
      </span>
    </div>
  )
}
