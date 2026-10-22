import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { createUser } from '../harness/helpers'
// createUser seeds through the harness's own retrying seed()
import { signJwt } from '../harness/jwt'

/**
 * WHO CAN READ AND WRITE WHAT, AS ONE SNAPSHOT (22 October 2026).
 *
 * Written before any policy changes, against the policies as they are: the
 * RLS rewrite that follows (policies evaluated once per statement, not once
 * per row) must leave this snapshot byte for byte the same. Everything is
 * recorded by fixture name, never by uuid, so the file is stable run to run.
 *
 * The snapshot proves UNCHANGED, not CORRECT: what it froze was read and
 * reported before it was committed (see the report of 22 October).
 *
 * Fixture: organizations A and B, and X which is disabled. Clients A1 and A2
 * (org A), B1, X1. Identities: a super admin; a super admin impersonating A;
 * the org admins of A, B and X; a client admin who is a member of A1 only; a
 * team member of A1; a team member of org A who is a member of nothing; anon.
 *
 * The super admin sees the whole shared test database (other test files'
 * rows too), so every read here is filtered to the fixture's own ids, and
 * calls that can't be (all-clients analytics, the platform stats) are
 * recorded for the super admin as not comparable rather than as numbers.
 */

type Who = 'super' | 'superImpersonatingA' | 'orgAdminA' | 'orgAdminB' | 'orgAdminX' | 'clientAdminA1' | 'teamA1' | 'teamA_noClient' | 'anon'
type Matrix = Record<string, unknown>

/**
 * ONLY "allowed" OR "refused" IS RECORDED, never the error's code. In this
 * harness a statement the database refuses (an RLS check, a grant, the
 * impersonation guard) often comes back as 503 PGRST001 instead of its own
 * error, and the same refusal reads 42501 on one run and PGRST001 on the
 * next (measured 22 October 2026: the refused statement itself answers
 * PGRST001; the call after it is fine). That is pglite#958, the defect seed()
 * in helpers.ts works around. A first snapshot that kept the codes was
 * different on every run; whether a role could do a thing is what the
 * policies decide, and that is stable.
 *
 * The same defect has a second face: the call AFTER a refused statement
 * sometimes fails too ("Database connection error"), though nothing was
 * wrong with it. Five runs in a row on 22 October: one fixture insert and one
 * read failed that way. So a connection-type answer (503 PGRST000–003) is
 * retried twice: a statement the database really refuses answers the same
 * every time and is recorded refused; one that only stood next to a refusal
 * goes through. A connection error means the statement never ran, so a retry
 * can't run anything twice.
 */
// The request a failing fixture write was making, for its error message
let lastRequest = ''
// ONE REQUEST AT A TIME. PostgREST reaches PGlite over a single connection,
// and a refused statement takes down whatever runs beside it: ten runs on 22
// October, one fixture insert issued in parallel with refused deletes failed
// with PGRST000 and stayed failed. Serialised here, for every client of this
// file, nothing ever runs beside a refusal.
let queue: Promise<unknown> = Promise.resolve()
const oneAtATime: typeof fetch = (input, init) => {
  const run = queue.then(() => retryConnectionErrors(input, init))
  queue = run.catch(() => undefined)
  return run
}
const retryConnectionErrors: typeof fetch = async (input, init) => {
  lastRequest = `${init?.method ?? 'GET'} ${String(input).replace(/^https?:\/\/[^/]+/, '')} ${String(init?.body ?? '').slice(0, 160)}`
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(input, init)
    if (response.status !== 503) return response
    const code = /"code"\s*:\s*"(PGRST00[0-3])"/.exec(await response.clone().text())?.[1]
    // PGRST000: PostgREST has no connection yet and is backing off (seen
    // lasting over 150 ms): waited out for up to ~10 s. A refusal never
    // answers PGRST000, so this can't hide one. PGRST001–003: twice more.
    const limit = code === 'PGRST000' ? 15 : code ? 3 : 1
    if (attempt >= limit) return response
    await new Promise((resolve) => setTimeout(resolve, code === 'PGRST000' ? Math.min(200 * attempt, 1000) : 50 * attempt))
  }
}
const clientWith = (key: string) =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: oneAtATime },
  })

const service = clientWith(process.env.SUPABASE_SECRET_KEY!)
const label = new Map<string, string>()
const name = (id: string | null | undefined) => (id ? (label.get(id) ?? `?${id.slice(0, 8)}`) : null)
const tag = randomUUID().slice(0, 8)

/** A fixture write that must succeed; every one selects the row's id */
async function must(query: PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status?: number }>): Promise<{ id: string }> {
  const { data, error, status } = await query
  if (error || data === null || data === undefined) {
    throw new Error(`fixture: ${status} ${error?.code} ${error?.message ?? 'no row'} — ${lastRequest}`)
  }
  return data as { id: string }
}

// The fixture's ids, by fixture name
const ids = {
  org: {} as Record<string, string>,
  client: {} as Record<string, string>,
  channel: {} as Record<string, string>,
  user: {} as Record<string, string>,
  conversation: {} as Record<string, string>,
  message: {} as Record<string, string>,
  lead: {} as Record<string, string>,
  branch: {} as Record<string, string>,
  closure: {} as Record<string, string>,
  knowledge: {} as Record<string, string>,
  member: {} as Record<string, string>,
}
const remember = (kind: keyof typeof ids, key: string, id: string, as = key) => {
  ids[kind][key] = id
  label.set(id, as)
}

let clients: Record<Who, SupabaseClient>

async function seedFixture() {
  for (const org of ['A', 'B', 'X']) {
    const row = await must(service.from('organizations').insert({ name: `Org ${org} ${tag}`, slug: `org-${org.toLowerCase()}-${tag}` }).select('id').single())
    remember('org', org, row.id, `org${org}`)
  }
  for (const [client, org] of [['A1', 'A'], ['A2', 'A'], ['B1', 'B'], ['X1', 'X']] as const) {
    const row = await must(
      service.from('clients').insert({ organization_id: ids.org[org], name: `Client ${client}`, slug: `c-${client.toLowerCase()}-${tag}` }).select('id').single()
    )
    remember('client', client, row.id)
    const channel = await must(service.from('channels').insert({ client_id: row.id, type: 'website', name: `Website ${client}` }).select('id').single())
    remember('channel', client, channel.id, `channel ${client}`)
    // The default branch the client was created with (create_default_branch)
    const branch = await must(service.from('branches').select('id').eq('client_id', row.id).single())
    remember('branch', client, branch.id, `branch ${client}`)
    const closure = await must(
      service.from('branch_closures').insert({ client_id: row.id, branch_id: branch.id, date: '2027-01-07', reason: 'holiday' }).select('id').single()
    )
    remember('closure', client, closure.id, `closure ${client}`)
    const doc = await must(service.from('knowledge_documents').insert({ client_id: row.id, title: `Doc ${client}`, content: 'x' }).select('id').single())
    remember('knowledge', client, doc.id, `doc ${client}`)
  }

  const users: [Who, Parameters<typeof createUser>[0], string | null][] = [
    ['super', 'super_admin', null],
    ['superImpersonatingA', 'super_admin', null],
    ['orgAdminA', 'org_admin', 'A'],
    ['orgAdminB', 'org_admin', 'B'],
    ['orgAdminX', 'org_admin', 'X'],
    ['clientAdminA1', 'client_admin', 'A'],
    ['teamA1', 'team_member', 'A'],
    ['teamA_noClient', 'team_member', 'A'],
  ]
  for (const [who, role, org] of users) {
    const user = await createUser(role, org ? ids.org[org] : null, `${who} ${tag}`)
    remember('user', who, user.id)
  }
  for (const [who, client, role] of [['clientAdminA1', 'A1', 'client_admin'], ['teamA1', 'A1', 'team_member']] as const) {
    const row = await must(service.from('client_members').insert({ client_id: ids.client[client], user_id: ids.user[who], role }).select('id').single())
    remember('member', `${who}@${client}`, row.id, `membership ${who}@${client}`)
  }
  // Organization X is disabled, the super admin impersonating A has an open session
  await must(service.from('organizations').update({ is_active: false }).eq('id', ids.org.X).select('id'))
  await must(service.from('impersonation_sessions').insert({ super_admin_id: ids.user.superImpersonatingA, target_organization_id: ids.org.A }).select('id'))

  // Conversations: in A1 one assigned to its team member, one to the client
  // admin, one to nobody; in A2 one assigned to A1's team member, who is not a
  // member of A2; one each in B1 and X1
  const conversations: [string, string, Who | null, boolean][] = [
    ['A1 assigned teamA1', 'A1', 'teamA1', true],
    ['A1 assigned clientAdminA1', 'A1', 'clientAdminA1', false],
    ['A1 unassigned', 'A1', null, true],
    ['A2 assigned teamA1', 'A2', 'teamA1', false],
    ['B1 unassigned', 'B1', null, true],
    ['X1 unassigned', 'X1', null, false],
  ]
  for (const [key, client, assignee, needsHuman] of conversations) {
    const row = await must(
      service
        .from('conversations')
        .insert({
          client_id: ids.client[client],
          channel_id: ids.channel[client],
          contact_identifier: `visitor-${tag}-${key.replace(/\W+/g, '-')}`,
          assigned_to: assignee ? ids.user[assignee] : null,
          ...(needsHuman ? { needs_human_since: new Date().toISOString(), needs_human_reason: 'no_answer' } : {}),
        })
        .select('id')
        .single()
    )
    remember('conversation', key, row.id, `conversation ${key}`)
    for (const role of ['user', 'assistant'] as const) {
      const message = await must(service.from('messages').insert({ conversation_id: row.id, role, content: `${role} in ${key}` }).select('id').single())
      remember('message', `${key}/${role}`, message.id, `message ${key}/${role}`)
    }
    // A complete lead on every conversation
    const lead = await must(
      service.from('leads').insert({ client_id: ids.client[client], conversation_id: row.id, name: `Visitor ${key}`, phone: '+201000000000' }).select('id').single()
    )
    remember('lead', key, lead.id, `lead ${key}`)
  }
  // Leads with no conversation: one incomplete in A1 (hidden from everyone but the super admin), one with an appointment
  const partial = await must(service.from('leads').insert({ client_id: ids.client.A1, name: 'Name only' }).select('id').single())
  remember('lead', 'A1 incomplete', partial.id, 'lead A1 incomplete')
  const booked = await must(
    service
      .from('leads')
      .insert({
        client_id: ids.client.A1,
        name: 'Booked',
        phone: '+201000000001',
        status: 'appointment_booked',
        appointment_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      })
      .select('id')
      .single()
  )
  remember('lead', 'A1 booked', booked.id, 'lead A1 booked')
  // lead_events the triggers wrote, labelled by their lead
  const { data: events } = await service.from('lead_events').select('id, lead_id, event_type').in('lead_id', Object.values(ids.lead))
  for (const e of events ?? []) label.set(e.id, `event ${name(e.lead_id)}:${e.event_type}`)

  clients = {
    anon: clientWith(signJwt({ role: 'anon', iss: 'supabase' })),
    ...(Object.fromEntries(
      users.map(([who]) => [who, clientWith(signJwt({ sub: ids.user[who], role: 'authenticated', iss: 'supabase' }))])
    ) as Record<Exclude<Who, 'anon'>, SupabaseClient>),
  }
}

const outcome = (error: { code?: string; message: string } | null) => (error ? 'refused' : null)
const sorted = (labels: (string | null)[]) => labels.filter((l): l is string => l !== null).sort()
/** An object from entries, keys sorted: rows come back in the database's order, which is not a result */
const byKey = (entries: [unknown, unknown][]) => Object.fromEntries(entries.map(([k, v]) => [String(k), v] as const).sort(([a], [b]) => a.localeCompare(b)))

/** What `who` sees of a table, restricted to the fixture's rows */
async function visible(db: SupabaseClient, table: string, column: string, among: string[]) {
  const { data, error } = await db.from(table).select(column).in(column, among)
  if (error) return outcome(error)
  return sorted((data as unknown as Record<string, string>[]).map((row) => name(row[column])))
}

/** Rows a no-op update reaches (count from the database, whether or not the row can be read back) */
async function updates(db: SupabaseClient, table: string, patch: Record<string, unknown>, rows: Record<string, string>) {
  const result: Record<string, number | string> = {}
  for (const [key, id] of Object.entries(rows)) {
    const { count, error } = await db.from(table).update(patch, { count: 'exact' }).eq('id', id)
    result[key] = error ? (outcome(error) as string) : (count ?? 0)
  }
  return result
}

const PERIOD = () => ({ p_from: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), p_to: new Date(Date.now() + 24 * 3600 * 1000).toISOString() })
const sum = (rows: Record<string, unknown>[] | null, field: string) => (rows ?? []).reduce((total, row) => total + Number(row[field] ?? 0), 0)

/** Every analytics function, scoped to one client (or all, with null), reduced to what doesn't depend on the clock */
async function analytics(db: SupabaseClient, clientId: string | null) {
  const period = { p_client_id: clientId, ...PERIOD() }
  const call = async (fn: string, args: Record<string, unknown>, reduce: (rows: Record<string, unknown>[]) => unknown) => {
    const { data, error } = await db.rpc(fn, args)
    return error ? outcome(error) : reduce(data as Record<string, unknown>[])
  }
  return {
    conversations_over_time: await call('get_conversations_over_time', { ...period, p_granularity: 'day' }, (r) => sum(r, 'conversations')),
    leads_over_time: await call('get_leads_over_time', { ...period, p_granularity: 'day' }, (r) => sum(r, 'leads')),
    channel_distribution: await call('get_channel_distribution', period, (r) => sum(r, 'conversations')),
    peak_hours: await call('get_peak_hours', period, (r) => sum(r, 'messages')),
    lead_status_breakdown: await call('get_lead_status_breakdown', period, (r) =>
      byKey(r.filter((row) => Number(row.leads) > 0).map((row) => [row.status, Number(row.leads)]))
    ),
    response_time: await call('get_response_time_stats', period, (r) => ({
      conversations: Number(r[0]?.conversations ?? 0),
      responded: Number(r[0]?.responded ?? 0),
      agent_responded: Number(r[0]?.agent_responded ?? 0),
    })),
    journey: await call('get_journey_stats', period, (r) =>
      byKey(
        r.filter((row) => label.has(row.client_id as string)).map((row) => [name(row.client_id as string), { leads: Number(row.leads_count), booked: Number(row.booked_count) }])
      )
    ),
    upcoming_appointments: await call('get_upcoming_appointments', { p_client_id: clientId, p_days_ahead: 7 }, (r) =>
      sorted(r.filter((row) => label.has(row.id as string)).map((row) => name(row.id as string)))
    ),
  }
}

async function readsFor(who: Who): Promise<Matrix> {
  const db = clients[who]
  const everyone = who === 'super'
  const read = {
    organizations: await visible(db, 'organizations', 'id', Object.values(ids.org)),
    users: await visible(db, 'users', 'id', Object.values(ids.user)),
    clients: await visible(db, 'clients', 'id', Object.values(ids.client)),
    client_members: await visible(db, 'client_members', 'id', Object.values(ids.member)),
    channels: await visible(db, 'channels', 'id', Object.values(ids.channel)),
    branches: await visible(db, 'branches', 'id', Object.values(ids.branch)),
    branch_closures: await visible(db, 'branch_closures', 'id', Object.values(ids.closure)),
    bot_settings: await (async () => {
      const { data, error } = await db.from('bot_settings').select('client_id').in('client_id', Object.values(ids.client))
      return error ? outcome(error) : sorted((data ?? []).map((row) => name(row.client_id)))
    })(),
    knowledge_documents: await visible(db, 'knowledge_documents', 'id', Object.values(ids.knowledge)),
    conversations: await visible(db, 'conversations', 'id', Object.values(ids.conversation)),
    messages: await visible(db, 'messages', 'id', Object.values(ids.message)),
    leads: await visible(db, 'leads', 'id', Object.values(ids.lead)),
    lead_events: await (async () => {
      const { data, error } = await db.from('lead_events').select('id').in('lead_id', Object.values(ids.lead))
      return error ? outcome(error) : sorted((data ?? []).map((row) => name(row.id)))
    })(),
  }

  const rpc = {
    // The layout's badge counts, on every dashboard page
    needs_human_counts: everyone
      ? 'not comparable: the super admin sees every client in the shared test database'
      : await (async () => {
          const { data, error } = await db.rpc('needs_human_counts')
          return error ? outcome(error) : byKey((data ?? []).map((row: { reason: string; conversations: number }) => [row.reason, Number(row.conversations)]))
        })(),
    client_team: Object.fromEntries(
      await Promise.all(
        Object.entries(ids.client).map(async ([client, id]) => {
          const { data, error } = await db.rpc('client_team', { check_client_id: id })
          return [client, error ? outcome(error) : sorted((data ?? []).map((row: { id: string }) => name(row.id)))]
        })
      )
    ),
    analytics_all_clients: everyone ? 'not comparable: the super admin sees every client in the shared test database' : await analytics(db, null),
    analytics_by_client: Object.fromEntries(await Promise.all(Object.entries(ids.client).map(async ([client, id]) => [client, await analytics(db, id)]))),
    client_performance: everyone
      ? 'not comparable: the super admin sees every client in the shared test database'
      : await (async () => {
          const { data, error } = await db.rpc('get_client_performance', PERIOD())
          return error
            ? outcome(error)
            : byKey(
                (data ?? [])
                  .filter((row: { client_id: string }) => label.has(row.client_id))
                  .map((row: { client_id: string; conversations: number; leads: number }) => [name(row.client_id), { conversations: Number(row.conversations), leads: Number(row.leads) }])
              )
        })(),
    // Super-admin functions (security definer, gated by is_super_admin())
    organization_details_A: await (async () => {
      const { data, error } = await db.rpc('get_organization_details', { p_org_id: ids.org.A })
      if (error) return outcome(error)
      const rows = (Array.isArray(data) ? data : data ? [data] : []) as unknown[]
      return rows.length > 0 ? 'returned' : 'empty'
    })(),
    platform_stats: await (async () => {
      const { data, error } = await db.from('platform_stats').select('*')
      if (error) return outcome(error)
      const row = (data ?? [])[0] as Record<string, unknown> | undefined
      return row && Object.values(row).some((v) => v !== null && Number(v) > 0) ? 'returned figures' : 'empty or zero'
    })(),
  }

  return { read, rpc }
}

/**
 * Writes, run only after every identity's reads: a write probe can change
 * what the next identity reads (the first run proved it: an agent's message
 * clears the needs-human mark through a trigger). No-op updates first (the
 * same value written back), safe whatever they reach; then inserts and
 * deletes on rows made for the probe and removed after it.
 */
async function writesFor(who: Who): Promise<Matrix> {
  const db = clients[who]
  const write: Matrix = {
    update: {
      conversations: await updates(db, 'conversations', { status: 'new' }, ids.conversation),
      messages: await updates(db, 'messages', { metadata: null }, ids.message),
      leads: await updates(db, 'leads', { notes: null }, ids.lead),
      clients: await updates(db, 'clients', { industry: null }, ids.client),
      channels: await updates(db, 'channels', { is_active: true }, ids.channel),
      branches: await updates(db, 'branches', { is_active: true }, ids.branch),
      branch_closures: await updates(db, 'branch_closures', { reason: 'holiday' }, ids.closure),
      knowledge_documents: await updates(db, 'knowledge_documents', { content: 'x' }, ids.knowledge),
      // Each membership's own role written back
      client_members: {
        ...(await updates(db, 'client_members', { role: 'client_admin' }, { 'clientAdminA1@A1': ids.member['clientAdminA1@A1'] })),
        ...(await updates(db, 'client_members', { role: 'team_member' }, { 'teamA1@A1': ids.member['teamA1@A1'] })),
      },
      users: await updates(db, 'users', { avatar_url: null }, ids.user),
      organizations: await updates(db, 'organizations', { logo_url: null }, ids.org),
    },
    insert: {
      conversations: Object.fromEntries(
        await Promise.all(
          Object.entries(ids.client).map(async ([client, id]) => {
            const contact = `probe-${who}-${client}-${tag}`
            const { error } = await db.from('conversations').insert({ client_id: id, channel_id: ids.channel[client], contact_identifier: contact })
            await service.from('conversations').delete().eq('contact_identifier', contact)
            return [client, outcome(error) ?? 'inserted']
          })
        )
      ),
      // An agent's message signed as themselves, in each conversation
      agent_messages: Object.fromEntries(
        await Promise.all(
          Object.entries(ids.conversation).map(async ([key, id]) => {
            const content = `probe-${who}-${tag}`
            const { error } =
              who === 'anon'
                ? await db.from('messages').insert({ conversation_id: id, role: 'agent', content })
                : await db.from('messages').insert({ conversation_id: id, role: 'agent', content, sender_id: ids.user[who] })
            await service.from('messages').delete().eq('conversation_id', id).eq('content', content)
            return [key, outcome(error) ?? 'inserted']
          })
        )
      ),
      leads: Object.fromEntries(
        await Promise.all(
          Object.entries(ids.client).map(async ([client, id]) => {
            const probe = `probe-${who}-${tag}`
            const { error } = await db.from('leads').insert({ client_id: id, name: probe, phone: '+201000000009' })
            await service.from('leads').delete().eq('client_id', id).eq('name', probe)
            return [client, outcome(error) ?? 'inserted']
          })
        )
      ),
    },
    delete: {
      // A lead made for the probe in each client, complete and incomplete
      leads: Object.fromEntries(
        await Promise.all(
          Object.entries(ids.client).flatMap(([client, id]) =>
            (['complete', 'incomplete'] as const).map(async (kind) => {
              const probe = await must(
                service
                  .from('leads')
                  .insert({ client_id: id, name: `delete-probe-${who}`, ...(kind === 'complete' ? { phone: '+201000000008' } : {}) })
                  .select('id')
                  .single()
              )
              const { count, error } = await db.from('leads').delete({ count: 'exact' }).eq('id', probe.id)
              await service.from('leads').delete().eq('id', probe.id)
              return [`${client} ${kind}`, error ? outcome(error) : (count ?? 0)]
            })
          )
        )
      ),
      messages: Object.fromEntries(
        await Promise.all(
          Object.entries(ids.conversation).map(async ([key, id]) => {
            const probe = await must(service.from('messages').insert({ conversation_id: id, role: 'user', content: `delete-probe-${who}-${tag}` }).select('id').single())
            const { count, error } = await db.from('messages').delete({ count: 'exact' }).eq('id', probe.id)
            await service.from('messages').delete().eq('id', probe.id)
            return [key, error ? outcome(error) : (count ?? 0)]
          })
        )
      ),
      conversations: Object.fromEntries(
        await Promise.all(
          Object.entries(ids.client).map(async ([client, id]) => {
            const probe = await must(
              service.from('conversations').insert({ client_id: id, channel_id: ids.channel[client], contact_identifier: `delete-probe-${who}-${tag}` }).select('id').single()
            )
            const { count, error } = await db.from('conversations').delete({ count: 'exact' }).eq('id', probe.id)
            await service.from('conversations').delete().eq('id', probe.id)
            return [client, error ? outcome(error) : (count ?? 0)]
          })
        )
      ),
    },
  }
  return write
}

describe('access matrix: who can read and write what', () => {
  beforeAll(seedFixture, 60_000)

  it('is the snapshot, for every identity, every table, every analytics function', async () => {
    const everyone = Object.keys(clients) as Who[]
    const matrix: Record<string, Matrix> = {}
    for (const who of everyone) matrix[who] = await readsFor(who)
    for (const who of everyone) matrix[who].write = await writesFor(who)
    await expect(JSON.stringify(matrix, null, 2) + '\n').toMatchFileSnapshot('./access-matrix.snapshot.json')
  }, 300_000)
})
