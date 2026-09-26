import { requireClientManager } from '@/lib/auth/guards'

/**
 * Every page under a client (channels, knowledge base, bot settings,
 * playground) configures the client, so it's for client admins and up.
 * Team members who open one by URL are sent to their conversations.
 */
export default async function ClientPagesLayout({
  children,
  params,
}: LayoutProps<'/[locale]/dashboard/clients/[clientId]'>) {
  const { locale } = await params
  await requireClientManager(locale)
  return children
}
