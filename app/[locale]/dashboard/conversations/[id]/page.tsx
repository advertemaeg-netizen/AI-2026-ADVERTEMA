import { notFound, redirect } from 'next/navigation'
import { canManage, getSession } from '@/lib/auth/session'
import { getConversation } from '@/lib/actions/conversations'
import { ConversationView } from './_components/conversation-view'

export default async function ConversationPage({
  params,
}: PageProps<'/[locale]/dashboard/conversations/[id]'>) {
  const { id, locale } = await params
  const { profile } = await getSession()
  if (!profile) redirect(`/${locale}/login`)

  const result = await getConversation(id)
  if (!result) notFound()

  return (
    <ConversationView
      // remount on navigation between conversations so local state resets
      key={id}
      initialConversation={result.conversation}
      initialMessages={result.messages}
      team={result.team}
      canManage={canManage(profile)}
      currentUserId={profile.id}
    />
  )
}
