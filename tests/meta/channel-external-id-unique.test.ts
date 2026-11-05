import { afterAll, beforeAll, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from '../harness/stack'

/**
 * One active channel per Meta account (20261110100000). The webhook routes by
 * (type, external_id), so two live rows with one id would deliver a clinic's
 * messages to whichever the lookup found first. Paused duplicates are allowed;
 * a live duplicate is refused, on another client and on the same one.
 *
 * The rule lives in the database, so it is tested there: plain SQL on PGlite,
 * no PostgREST in between (a refused statement over PostgREST reads PGRST001
 * in this harness, pglite#958, and would take the shared connection with it).
 */
let db: PGlite
let clientA: string
let clientB: string

const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0].id

beforeAll(async () => {
  db = await createDatabase()
  const orgId = await one(`insert into organizations (name, slug) values ('Org', 'org') returning id`)
  clientA = await one(`insert into clients (organization_id, name, slug) values ($1, 'A', 'a') returning id`, [orgId])
  clientB = await one(`insert into clients (organization_id, name, slug) values ($1, 'B', 'b') returning id`, [orgId])
  // Channel seats are not the rule under test: this database is this file's alone
  await db.query(`update plans set channels_limit = null`)
})

afterAll(() => db.close())

const channel = (clientId: string, type: string, externalId: string | null, isActive = true) =>
  one(`insert into channels (client_id, type, name, external_id, is_active) values ($1, $2, $3, $4, $5) returning id`, [
    clientId,
    type,
    type,
    externalId,
    isActive,
  ])

const refused = { code: '23505', message: expect.stringContaining('channels_active_external_id_unique') }

it('refuses a second active channel with the same type and id, on another client', async () => {
  await channel(clientA, 'instagram', '17841400000000001')
  await expect(channel(clientB, 'instagram', '17841400000000001')).rejects.toMatchObject(refused)
})

it('allows a paused duplicate, and refuses resuming it while the other is live', async () => {
  await channel(clientA, 'whatsapp', 'PN-1')
  const paused = await channel(clientA, 'whatsapp', 'PN-1', false)
  await expect(db.query(`update channels set is_active = true where id = $1`, [paused])).rejects.toMatchObject(refused)
})

it('does not tie different types, or channels with no id', async () => {
  await channel(clientB, 'facebook', '981266905080015')
  await channel(clientB, 'instagram', '981266905080015')
  await channel(clientA, 'website', null)
  await channel(clientB, 'website', null)
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from channels where external_id = '981266905080015' and is_active`)
  expect(rows[0].n).toBe(2)
})
