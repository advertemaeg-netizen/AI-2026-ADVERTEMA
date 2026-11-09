import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createUser, seedClient } from '../harness/helpers'
import { signJwt } from '../harness/jwt'

/**
 * NOBODY BUT THE SERVER READS A CHANNEL'S TOKEN (26 October 2026).
 *
 * channel_secrets holds the access token that sends messages as the client;
 * processed_meta_messages holds Meta's delivery ids; meta_comment_replies
 * the claim on each comment and what was done with it; meta_connect_pending
 * the system-user token between Meta's return and the clinic's pick;
 * meta_pending_statuses a WhatsApp status held until its send records the
 * id; meta_post_authors whether a Facebook post is the Page's own. All six
 * are service-role only: row level security on with no policy, and every
 * table privilege revoked from anon and authenticated (20261102100000,
 * 20261103100000, 20261109100000, 20261111100000, 20261113100000,
 * 20261115100000). The point of the tables is that no
 * authenticated role can read them, so this is the test that fails the day
 * one can.
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
 * connection-type answer is retried before it is read as refused (by the
 * access project's global fetch, not by this file).
 */

type Who = 'super' | 'superImpersonating' | 'orgAdmin' | 'clientAdmin' | 'teamMember' | 'anon'
const EVERYONE: Who[] = ['super', 'superImpersonating', 'orgAdmin', 'clientAdmin', 'teamMember', 'anon']
const TABLES = ['channel_secrets', 'processed_meta_messages', 'meta_comment_replies', 'meta_connect_pending', 'meta_pending_statuses', 'meta_post_authors'] as const

// Serialised, retried and watched by the access project's global fetch (tests/harness/access-fetch.ts)
const clientWith = (key: string) =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

const service = clientWith(process.env.SUPABASE_SECRET_KEY!)
let clients: Record<Who, SupabaseClient>
let channelId: string
let secondChannelId: string
let clientId: string
let pendingUserId: string
const pendingId = crypto.randomUUID()
const inTenMinutes = () => new Date(Date.now() + 600_000).toISOString()

beforeAll(async () => {
  const seeded = await seedClient()
  channelId = seeded.channelId
  clientId = seeded.clientId
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
  const { error: commentError } = await service.from('meta_comment_replies').insert({ comment_id: `comment.fixture.${channelId}`, channel_id: channelId })
  if (commentError) throw commentError
  const { error: statusError } = await service.from('meta_pending_statuses').insert({ message_id: `wamid.held.${channelId}`, channel_id: channelId, status: 'failed', error_codes: [131047] })
  if (statusError) throw statusError
  const { error: authorError } = await service.from('meta_post_authors').insert({ post_id: `post.fixture.${channelId}`, channel_id: channelId, page_owned: true })
  if (authorError) throw authorError
  pendingUserId = (await createUser('org_admin', seeded.organizationId, 'connecting')).id
  const { error: pendingError } = await service.from('meta_connect_pending').insert({
    id: pendingId,
    user_id: pendingUserId,
    client_id: clientId,
    channel_id: channelId,
    locale: 'ar',
    access_token: 'SYS-not-a-real-token',
    expires_at: inTenMinutes(),
  })
  if (pendingError) throw pendingError

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
  const { key, fixture, probe, change } = {
    channel_secrets: { key: 'channel_id', fixture: channelId, probe: { channel_id: secondChannelId, access_token: `probe-${who}` }, change: { waba_id: 'changed' } },
    processed_meta_messages: {
      key: 'message_id',
      fixture: `wamid.fixture.${channelId}`,
      probe: { message_id: `wamid.probe.${who}.${channelId}`, channel_id: secondChannelId },
      change: { received_at: new Date().toISOString() },
    },
    meta_comment_replies: {
      key: 'comment_id',
      fixture: `comment.fixture.${channelId}`,
      probe: { comment_id: `comment.probe.${who}.${channelId}`, channel_id: secondChannelId },
      change: { received_at: new Date().toISOString() },
    },
    meta_pending_statuses: {
      key: 'message_id',
      fixture: `wamid.held.${channelId}`,
      probe: { message_id: `wamid.held.probe.${who}.${channelId}`, channel_id: secondChannelId, status: 'failed' },
      change: { status: 'changed' },
    },
    meta_post_authors: {
      key: 'post_id',
      fixture: `post.fixture.${channelId}`,
      probe: { post_id: `post.probe.${who}.${channelId}`, channel_id: secondChannelId, page_owned: 'true' },
      change: { page_owned: 'false' },
    },
    meta_connect_pending: {
      key: 'id',
      fixture: pendingId,
      probe: { id: crypto.randomUUID(), user_id: pendingUserId, client_id: clientId, locale: 'en', expires_at: inTenMinutes() },
      change: { access_token: 'changed' },
    },
  }[table] as { key: string; fixture: string; probe: Record<string, string>; change: Record<string, string> }

  const select = await db.from(table).select('*')
  const selectOne = await db.from(table).select('*').eq(key, fixture)
  const insert = await db.from(table).insert(probe).select(key)
  await service.from(table).delete().eq(key, probe[key])
  const update = await db
    .from(table)
    .update(change, { count: 'exact' })
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

  // ONE TEST PER TABLE, then the matrix as a whole: what is asserted is the
  // same as one test made it (the per-table tests only collect; every
  // assertion is the final test's), checked line by line against the
  // committed version when this was restored (2026-11-09).
  //
  // TWO WAYS THIS FILE FAILS, and only one of them is cured by splitting
  // (tests/harness/access-fetch.ts, "THE STUCK STATE"; AGENTS.md):
  //   1. THE STUCK STATE. Every request takes ~10 s and nothing recovers:
  //      `[access] slow reconnect` marks, tests timing out one after another,
  //      the files after them failing on connection errors. About 3 runs in
  //      10. Splitting does NOT help it. It may be rerun, but only when
  //      scripts/access-stuck-signature.mjs says STUCK.
  //   2. A TEST OUTGROWING ITS LIMIT. A timeout with no slow-reconnect marks
  //      and no cascade: nothing is wrong with the connection, the test just
  //      takes longer than its limit. That is a REAL failure, never rerun.
  //      Six tables in one test took 86–96 s alone, and passed 120 s in a
  //      full run sharing the machine (2026-11-09); split, each table takes
  //      ~14 s alone, 20–25 s in a full run. Splitting cures this one.
  //      If a per-table test ever outgrows 180 s, stop and report: do not
  //      raise the limit.
  const matrix: Record<string, Record<string, Record<string, string>>> = {}
  const started = new Set<string>()
  const finished = new Set<string>()

  for (const table of TABLES) {
    it(`refuses every statement on ${table} from every identity`, async () => {
      started.add(table)
      matrix[table] = {}
      for (const who of EVERYONE) matrix[table][who] = await statementsFor(who, table)
      finished.add(table)
    }, 180_000)
  }

  // THE FINAL TEST CAN SKIP ITSELF, AND A SKIPPED FINAL TEST CAN NEVER
  // COEXIST WITH A GREEN RESULT. Every assertion about access is made here; the
  // tests above only collect. So:
  //   - a table whose test NEVER STARTED (filtered out with -t, or skipped):
  //     this test FAILS. Nothing about that table was verified, and a run that
  //     verified nothing about it must not read green;
  //   - a table whose test STARTED AND DID NOT FINISH: this test skips. The
  //     unfinished table's own test always fails the run (vitest reports a test
  //     that started and did not finish as failed, by its timeout or its thrown
  //     error, and a failed test exits the run non-zero), so a skipped final
  //     test can never coexist with a green result. Comparing the incomplete
  //     matrix would only add a snapshot mismatch caused by that failure, and
  //     a mismatch reads as a real assertion: it hid the stuck state from
  //     scripts/access-stuck-signature.mjs (2026-11-09, runs 7 and 2).
  it('refuse every statement from every identity: the snapshot, and every cell read back as refused', async (context) => {
    const neverRan = TABLES.filter((table) => !started.has(table))
    expect(neverRan, 'a table whose test never ran (filtered or skipped) is not verified').toEqual([])
    if (TABLES.some((table) => !finished.has(table))) context.skip()
    // Every table's test ran first, in this file's order
    expect(Object.keys(matrix)).toEqual([...TABLES])
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
    const { data: pending } = await service.from('meta_connect_pending').select('id, access_token').eq('channel_id', channelId)
    expect(pending).toEqual([{ id: pendingId, access_token: 'SYS-not-a-real-token' }])
    const { data: author } = await service.from('meta_post_authors').select('page_owned').eq('post_id', `post.fixture.${channelId}`).single()
    expect(author).toEqual({ page_owned: true })
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
