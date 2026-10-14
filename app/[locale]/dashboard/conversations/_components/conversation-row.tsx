import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { RelativeTime } from '@/components/relative-time'
import { StateBadge } from '@/components/ui/badge'
import { DEFAULT_NEEDS_HUMAN_REASON, type ConversationListItem } from '@/lib/types/conversations'
import { ContactAvatar, StatusBadge, useContactLabel } from './conversation-bits'

export function ConversationRow({ conversation }: { conversation: ConversationListItem }) {
  const t = useTranslations('conversations')
  const contactLabel = useContactLabel()

  const prefix =
    conversation.last_message_role === 'assistant'
      ? `${t('prefix.assistant')}: `
      : conversation.last_message_role === 'agent'
        ? `${t('prefix.agent')}: `
        : ''

  return (
    <Link
      href={`/dashboard/conversations/${conversation.id}`}
      className="flex gap-3 px-4 py-3 transition-colors duration-fast hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
    >
      <ContactAvatar name={conversation.contact_name} channelType={conversation.channel.type} />

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate font-medium">{contactLabel(conversation)}</p>
          <RelativeTime
            date={conversation.last_message_at}
            className="shrink-0 text-xs text-muted-foreground"
          />
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {conversation.client.name} · {conversation.channel.name}
        </p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="truncate text-sm text-muted-foreground">
            {conversation.last_message_preview ? (
              <>
                {prefix}
                {conversation.last_message_preview}
              </>
            ) : (
              t('noMessages')
            )}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.needs_human_since && (
              <StateBadge state={conversation.needs_human_reason ?? DEFAULT_NEEDS_HUMAN_REASON} variant="destructive">
                {t(`needsHuman.badge.${conversation.needs_human_reason ?? DEFAULT_NEEDS_HUMAN_REASON}`)}
              </StateBadge>
            )}
            <StatusBadge status={conversation.status} />
          </div>
        </div>
      </div>
    </Link>
  )
}
