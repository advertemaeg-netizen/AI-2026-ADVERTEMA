import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAnalytics, getConversationTrend } from '@/lib/actions/analytics'
import { getDashboardStats } from '@/lib/dashboard-stats'
import { canManageClient } from '@/lib/auth/permissions'
import { ANALYTICS_PRESETS } from '@/lib/types/analytics'
import { createUser, seedClient, serviceClient, type TestUser } from '../harness/helpers'

/**
 * ANALYTICS COUNT PRIVATE CONVERSATIONS ONLY (20261117100000; the comments tab
 * decisions, 1). One private conversation and one comment thread, each with a
 * message from the person and a reply: every count the clinic sees says one
 * conversation, and the channels chart, the hours chart and the response time
 * see only the private one. Nothing here reads created_at order.
 */

const session = { user: null as TestUser | null }
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => {
    const { userClient, serviceClient: service } = await import('../harness/helpers')
    return { supabase: session.user ? userClient(session.user.id) : service(), profile: session.user, impersonation: null }
  },
  isImpersonating: async () => false,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))

afterEach(() => {
  session.user = null
})

const DAY = 24 * 60 * 60_000

describe('analytics after the split', () => {
  it('a comment thread is not a conversation in any count the clinic sees', async () => {
    const seeded = await seedClient()
    const service = serviceClient()
    const { data: channel, error } = await service
      .from('channels')
      .insert({ client_id: seeded.clientId, type: 'instagram', name: 'Instagram', external_id: `IG-${crypto.randomUUID()}` })
      .select('id')
      .single<{ id: string }>()
    if (error) throw error
    for (const thread of ['dm', 'comments']) {
      const { data: conversation, error: conversationError } = await service
        .from('conversations')
        .insert({ client_id: seeded.clientId, channel_id: channel.id, contact_identifier: `P-${thread}`, thread, status: 'new' })
        .select('id')
        .single<{ id: string }>()
      if (conversationError) throw conversationError
      const { error: messagesError } = await service.from('messages').insert([
        { conversation_id: conversation.id, role: 'user', content: 'سؤال' },
        { conversation_id: conversation.id, role: 'assistant', content: 'رد' },
      ])
      if (messagesError) throw messagesError
    }
    session.user = await createUser('org_admin', seeded.organizationId, 'موظف')

    const now = Date.now()
    const from = new Date(now - 2 * DAY).toISOString()
    const to = new Date(now + DAY).toISOString()
    const data = await getAnalytics(seeded.clientId, { preset: ANALYTICS_PRESETS[0], from, to, fromDate: from.slice(0, 10), toDate: to.slice(0, 10), granularity: 'day' })
    expect(data).not.toBeNull()
    expect(data!.kpis.current.conversations).toBe(1)
    expect(data!.series.reduce((sum, row) => sum + row.conversations, 0)).toBe(1)
    expect(data!.channels).toEqual([{ channel: 'instagram', conversations: 1 }])
    expect(data!.peakHours.reduce((sum, row) => sum + row.messages, 0)).toBe(1)
    expect(data!.response.responded).toBe(1)

    const trend = await getConversationTrend(seeded.clientId, 3)
    expect(trend.reduce((sum, row) => sum + row.conversations, 0)).toBe(1)

    const stats = await getDashboardStats(seeded.clientId)
    expect(stats!.conversations.value).toBe(1)
    expect(JSON.stringify(stats!.recent)).not.toContain('P-comments')
  })
})
