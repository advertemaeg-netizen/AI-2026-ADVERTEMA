import 'server-only'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/auth/session'
import { canManageClient, isSuperAdmin } from '@/lib/auth/permissions'
import { getClientContext } from '@/lib/auth/client-context'

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

/** For the admin panel. Everyone else goes back to their dashboard. */
export async function requireSuperAdmin(locale: string) {
  const { profile } = await getSession()
  if (!profile) redirect(`/${locale}/login`)
  if (!isSuperAdmin(profile.role)) redirect(`/${locale}/dashboard`)
  return profile
}

/**
 * Agency-only pages (the clients list, agency billing, a client's billing
 * as seen by its agency): a direct business has one client and pays the
 * platform, so it's sent to `target` instead.
 */
export async function redirectDirectBusiness(locale: string, target = '/dashboard') {
  const context = await getClientContext()
  if (context?.orgType === 'direct') redirect(`/${locale}${target}`)
}
