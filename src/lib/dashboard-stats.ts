import 'server-only'
import { getSession } from '@/lib/auth/session'
import { ACTIVE_LEAD_STATUSES, type LeadStatus } from '@/lib/types/leads'

const DAY = 24 * 60 * 60 * 1000
const PERIOD_DAYS = 30

export type StatValue = { value: number; previous: number | null }

export type RecentItem =
  | { kind: 'lead'; id: string; title: string | null; client: string; status: LeadStatus; at: string }
  | { kind: 'conversation'; id: string; title: string | null; identifier: string | null; client: string; at: string }

/**
 * Overview numbers for the signed-in user (RLS scopes everything):
 * last 30 days compared with the 30 days before.
 */
export async function getDashboardStats() {
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const now = Date.now()
  const periodStart = new Date(now - PERIOD_DAYS * DAY).toISOString()
  const previousStart = new Date(now - 2 * PERIOD_DAYS * DAY).toISOString()

  const count = async (table: 'conversations' | 'leads', from: string, to?: string) => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true }).gte('created_at', from)
    if (to) query = query.lt('created_at', to)
    const { count: n, error } = await query
    if (error) throw new Error(`Failed to count ${table}: ${error.message}`)
    return n ?? 0
  }

  const [
    conversations,
    previousConversations,
    leads,
    previousLeads,
    activeLeads,
    clients,
    recentLeads,
    recentConversations,
  ] = await Promise.all([
    count('conversations', periodStart),
    count('conversations', previousStart, periodStart),
    count('leads', periodStart),
    count('leads', previousStart, periodStart),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .in('status', ACTIVE_LEAD_STATUSES)
      .then(({ count: n }) => n ?? 0),
    supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .then(({ count: n }) => n ?? 0),
    supabase
      .from('leads')
      .select('id, name, status, created_at, client:clients!inner(name)')
      .order('created_at', { ascending: false })
      .limit(5)
      .returns<{ id: string; name: string | null; status: LeadStatus; created_at: string; client: { name: string } }[]>(),
    supabase
      .from('conversations')
      .select('id, contact_name, contact_identifier, last_message_at, client:clients!inner(name)')
      .order('last_message_at', { ascending: false })
      .limit(5)
      .returns<{ id: string; contact_name: string | null; contact_identifier: string | null; last_message_at: string; client: { name: string } }[]>(),
  ])

  // Share of new conversations that produced a lead
  const rate = (l: number, c: number) => (c > 0 ? Math.min(l / c, 1) : 0)

  const recent: RecentItem[] = [
    ...(recentLeads.data ?? []).map((l) => ({
      kind: 'lead' as const,
      id: l.id,
      title: l.name,
      client: l.client.name,
      status: l.status,
      at: l.created_at,
    })),
    ...(recentConversations.data ?? []).map((c) => ({
      kind: 'conversation' as const,
      id: c.id,
      title: c.contact_name,
      identifier: c.contact_identifier,
      client: c.client.name,
      at: c.last_message_at,
    })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8)

  return {
    conversations: { value: conversations, previous: previousConversations } satisfies StatValue,
    // Active = still being worked; change compares new leads per period
    activeLeads: { value: activeLeads, newThisPeriod: leads, newPrevious: previousLeads },
    clients,
    conversionRate: {
      value: rate(leads, conversations),
      previous: previousConversations > 0 ? rate(previousLeads, previousConversations) : null,
    } satisfies StatValue,
    recent,
  }
}
