import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createUser, seedClient } from '../harness/helpers'
import { signJwt } from '../harness/jwt'

/**
 * NOBODY BUT THE SERVER READS A CHANNEL'S TOKEN (26 October 2026).
 *
 * channel_secrets holds the access token that sends messages as the client;
 * processed_meta_messages holds Meta's delivery ids. Both are service-role
 * only: row level security on with no policy, and every table privilege
 * revoked from anon and authenticated (20261102100000, 20261103100000). The
 * point of the tables is that no authenticated role can read them, so this
 * is the test that fails the day one can.
 *
 * Frozen the way the access matrix is: for every identity, every statement,
 * recorded as allowed or refused and compared to a snapshot — and, since a
 * regenerated snapshot would accept anything, also asserted outright: every
 * cell for every identity but the service role is "refused". Not "no rows":
 * a select that comes back empty means a grant is in place and only RLS
 * stands between a dashboard query and the token.
 *
 * Identities: a super admin; a super admin impersonating the organization;
 * the org admin; a client admin who is a member of the client; a team
 * member of the client; anon. The matrix's own refusal-handling applies:
 * in this harness a refused statement sometimes answers 503 PGRST001 and
 * can fail the call after it (pglite#958), so calls are serialised and a
 * connection-type answer is retried before it is read as refused.
 */

type Who = 'super' | 'superImpersonating' | 'orgAdmin' | 'clientAdmin' | 'teamMember' | 'anon'
const EVERYONE: Who[] = ['super', 'superImpersonating', 'orgAdmin', 'clientAdmin', 'teamMember', 'anon']
const TABLES = ['channel_secrets', 'processed_meta_messages'] as const

let queue: Promise<unknown> = Promise.resolve()
const oneAtATime: typeof fetch = (input, init) => {
  const run = queue.then(() => retryConnectionErrors(input, init))
  queue = run.catch(() => undefined)
  return run
}
const retryConnectionErrors: typeof fetch = async (input, init) => {
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(input, init)
    if (response.status !== 503) return response
    const code = /"code"\s*:\s*"(PGRST00[0-3])"/.exec(await response.clone().text())?.[1]
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
let clients: Record<Who, SupabaseClient>
let channelId: string
let secondChannelId: string

beforeAll(async () => {
  const seeded = await seedClient()
  channelId = seeded.channelId
  // A second channel, for the insert probes: a probe that succeeded would otherwise collide with the fixture row
  const { data: second, error: secondError } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type: 'whatsapp', name: 'WhatsApp probe', external_id: `probe-${channelId}` })
    .select('id')
    .single<{ id: string }>()
  if (secondError) throw secondError
  secondChannelId = second.id

  // The rows the identities are measured against, written as only the server may
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channelId, access_token: 'EAAG-not-a-real-token', waba_id: '1234567890' })
  if (secretError) throw secretError
  const { error: processedError } = await service.from('processed_meta_messages').insert({ message_id: `wamid.fixture.${channelId}`, channel_id: channelId })
  if (processedError) throw processedError

  const superAdmin = await createUser('super_admin', null, 'super')
  const impersonating = await createUser('super_admin', null, 'super impersonating')
  const orgAdmin = await createUser('org_admin', seeded.organizationId, 'org admin')
  const clientAdmin = await createUser('client_admin', seeded.organizationId, 'client admin')
  const teamMember = await createUser('team_member', seeded.organizationId, 'team member')
  for (const [user, role] of [
    [clientAdmin, 'client_admin'],
    [teamMember, 'team_member'],
  ] as const) {
    const { error } = await service.from('client_members').insert({ client_id: seeded.clientId, user_id: user.id, role })
    if (error) throw error
  }
  const { error: sessionError } = await service
    .from('impersonation_sessions')
    .insert({ super_admin_id: impersonating.id, target_organization_id: seeded.organizationId })
  if (sessionError) throw sessionError

  const as = (id: string) => clientWith(signJwt({ sub: id, role: 'authenticated', iss: 'supabase' }))
  clients = {
    super: as(superAdmin.id),
    superImpersonating: as(impersonating.id),
    orgAdmin: as(orgAdmin.id),
    clientAdmin: as(clientAdmin.id),
    teamMember: as(teamMember.id),
    anon: clientWith(signJwt({ role: 'anon', iss: 'supabase' })),
  }
}, 120_000)

type Cell = 'refused' | 'allowed' | 'allowed, no rows'
const outcome = (error: unknown, rows: unknown[] | null | undefined): Cell =>
  error ? 'refused' : (rows ?? []).length > 0 ? 'allowed' : 'allowed, no rows'

/** Every statement an identity could try, as allowed or refused. Writes are probes that leave nothing behind */
async function statementsFor(who: Who, table: (typeof TABLES)[number]) {
  const db = clients[who]
  const key = table === 'channel_secrets' ? 'channel_id' : 'message_id'
  const fixture = table === 'channel_secrets' ? channelId : `wamid.fixture.${channelId}`
  const probe: Record<string, string> =
    table === 'channel_secrets'
      ? { channel_id: secondChannelId, access_token: `probe-${who}` }
      : { message_id: `wamid.probe.${who}.${channelId}`, channel_id: secondChannelId }

  const select = await db.from(table).select('*')
  const selectOne = await db.from(table).select('*').eq(key, fixture)
  const insert = await db.from(table).insert(probe).select(key)
  await service.from(table).delete().eq(key, probe[key])
  const update = await db
    .from(table)
    .update(table === 'channel_secrets' ? { waba_id: 'changed' } : { received_at: new Date().toISOString() }, { count: 'exact' })
    .eq(key, fixture)
  const del = await db.from(table).delete({ count: 'exact' }).eq(key, fixture)
  return {
    select: outcome(select.error, select.data),
    select_one: outcome(selectOne.error, selectOne.data),
    insert: outcome(insert.error, insert.data),
    update: update.error ? 'refused' : `allowed, ${update.count ?? 0} rows`,
    delete: del.error ? 'refused' : `allowed, ${del.count ?? 0} rows`,
  }
}

describe('channel_secrets and processed_meta_messages are the server\'s alone', () => {
  it('exist, hold the fixture rows for the service role, and keep them through the probes', async () => {
    for (const table of TABLES) {
      const { data, error } = await service.from(table).select('channel_id').eq('channel_id', channelId)
      expect(error).toBeNull()
      expect(data).toEqual([{ channel_id: channelId }])
    }
  })

  it('refuse every statement from every identity: the snapshot, and every cell read back as refused', async () => {
    const matrix: Record<string, Record<string, Record<string, string>>> = {}
    for (const table of TABLES) {
      matrix[table] = {}
      for (const who of EVERYONE) matrix[table][who] = await statementsFor(who, table)
    }
    const allowed = Object.entries(matrix).flatMap(([table, byWho]) =>
      Object.entries(byWho).flatMap(([who, cells]) =>
        Object.entries(cells)
          .filter(([, cell]) => cell !== 'refused')
          .map(([statement, cell]) => `${table}: ${who} ${statement} → ${cell}`)
      )
    )
    expect(allowed).toEqual([])
    await expect(JSON.stringify(matrix, null, 2) + '\n').toMatchFileSnapshot('./channel-secrets.snapshot.json')

    // The probes changed nothing: the fixture rows are as they were written
    const { data: secret } = await service.from('channel_secrets').select('access_token, waba_id').eq('channel_id', channelId).single()
    expect(secret).toEqual({ access_token: 'EAAG-not-a-real-token', waba_id: '1234567890' })
    const { data: processed } = await service.from('processed_meta_messages').select('message_id').eq('channel_id', channelId)
    expect(processed).toEqual([{ message_id: `wamid.fixture.${channelId}` }])
  }, 120_000)

  it('a repeated delivery id is refused by the key, which is the whole idempotency mechanism', async () => {
    const { data: first, error: firstError } = await service
      .from('processed_meta_messages')
      .upsert({ message_id: `wamid.retry.${channelId}`, channel_id: channelId }, { onConflict: 'message_id', ignoreDuplicates: true })
      .select('message_id')
    expect(firstError).toBeNull()
    expect(first).toEqual([{ message_id: `wamid.retry.${channelId}` }])
    // The retry: insert … on conflict do nothing inserts no row, and that is how the webhook tells a repeat
    const { data: again, error: againError } = await service
      .from('processed_meta_messages')
      .upsert({ message_id: `wamid.retry.${channelId}`, channel_id: channelId }, { onConflict: 'message_id', ignoreDuplicates: true })
      .select('message_id')
    expect(againError).toBeNull()
    expect(again).toEqual([])
  })
})
