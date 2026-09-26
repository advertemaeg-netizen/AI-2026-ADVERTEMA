import { getTranslations } from 'next-intl/server'
import { MessagesSquare } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getConversations } from '@/lib/actions/conversations'
import { getClients } from '@/lib/actions/clients'
import { parseListFilters } from '@/lib/list-filters'
import { CONVERSATION_STATUSES } from '@/lib/types/conversations'
import { ListFiltersBar } from '@/components/list-filters-bar'
import { InboxRealtime } from './_components/inbox-realtime'
import { ConversationRow } from './_components/conversation-row'

export default async function ConversationsPage({
  searchParams,
}: PageProps<'/[locale]/dashboard/conversations'>) {
  const filters = parseListFilters(await searchParams, CONVERSATION_STATUSES)
  const t = await getTranslations('conversations')
  const [conversations, clients] = await Promise.all([getConversations(filters), getClients()])

  const hasFilters = Object.values(filters).some(Boolean)

  return (
    <div className="p-8">
      <InboxRealtime />

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <ListFiltersBar
        namespace="conversations"
        statuses={CONVERSATION_STATUSES}
        filters={filters}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
      />

      <Card className="mt-4 py-0">
        <CardContent className="px-0">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
              <MessagesSquare className="size-8" />
              {hasFilters ? t('emptyFiltered') : t('empty')}
            </div>
          ) : (
            <ul className="divide-y">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <ConversationRow conversation={conversation} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {conversations.length >= 100 && (
        <p className="mt-3 text-center text-xs text-muted-foreground">{t('limitNotice')}</p>
      )}
    </div>
  )
}
