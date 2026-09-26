'use server'

import { cookies } from 'next/headers'
import {
  getClientContext,
  SELECTED_CLIENT_COOKIE,
  SELECTED_CLIENT_COOKIE_OPTIONS,
} from '@/lib/auth/client-context'

/** Scopes the dashboard to a client (null = all clients, org admins only). */
export async function setSelectedClient(clientId: string | null): Promise<{ ok: boolean }> {
  const context = await getClientContext()
  if (!context) return { ok: false }

  const store = await cookies()
  if (clientId === null) {
    if (!context.canSeeAll) return { ok: false }
    store.delete(SELECTED_CLIENT_COOKIE)
    return { ok: true }
  }

  // Only clients this user can see (RLS) may be selected
  if (!context.clients.some((client) => client.id === clientId)) return { ok: false }
  store.set(SELECTED_CLIENT_COOKIE, clientId, SELECTED_CLIENT_COOKIE_OPTIONS)
  return { ok: true }
}
