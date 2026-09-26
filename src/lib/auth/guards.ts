import 'server-only'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { canManageClient } from '@/lib/auth/permissions'

/**
 * For pages only client managers may open (channels, knowledge base, bot
 * settings, playground, team). Team members land on the conversations page.
 */
export async function requireClientManager(locale: string) {
  const { profile } = await getSession()
  if (!profile) redirect(`/${locale}/login`)
  if (!canManageClient(profile.role)) redirect(`/${locale}/dashboard/conversations`)
  return profile
}
