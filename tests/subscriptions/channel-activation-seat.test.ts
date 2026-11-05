import { afterAll, beforeAll, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from '../harness/stack'

/**
 * Turning a channel on takes a seat (20261112100000). Since 20261106 a paused
 * channel holds no seat, and the limit was enforced on insert only: pause one,
 * add another, turn the first back on, and the client was over its plan with
 * no error. A channel connected through Meta is created paused and turned on
 * from its card, so the turning on is where the limit has to hold.
 *
 * The rule lives in the database, so it is tested there: plain SQL on its own
 * PGlite (a refused statement over PostgREST reads PGRST001 in this harness,
 * pglite#958).
 */
let db: PGlite
let clientId: string

const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0].id
const channel = (name: string, isActive: boolean) =>
  one(`insert into channels (client_id, type, name, is_active) values ($1, 'website', $2, $3) returning id`, [clientId, name, isActive])
const turnOn = (id: string) => db.query(`update channels set is_active = true where id = $1`, [id])
const turnOff = (id: string) => db.query(`update channels set is_active = false where id = $1`, [id])

beforeAll(async () => {
  db = await createDatabase()
  const orgId = await one(`insert into organizations (name, slug) values ('Org', 'org') returning id`)
  clientId = await one(`insert into clients (organization_id, name, slug) values ($1, 'Clinic', 'clinic') returning id`, [orgId])
  // One seat: this database is this file's alone
  await db.query(`update plans set channels_limit = 1`)
  // The client's default channel, if one was made, out of the way
  await db.query(`delete from channels where client_id = $1`, [clientId])
})

afterAll(() => db.close())

it('refuses turning a paused channel on when the plan has no seat, and allows it once one is free', async () => {
  const paused = await channel('connected, paused', false)
  const live = await channel('live', true)

  await expect(turnOn(paused)).rejects.toMatchObject({ message: 'subscription_limit:channels' })

  await turnOff(live)
  await turnOn(paused)
  const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from channels where client_id = $1 and is_active`, [clientId])
  expect(rows[0].n).toBe(1)
})

it('leaves turning a channel off, and updates that do not turn one on, alone', async () => {
  const { rows } = await db.query<{ id: string }>(`select id from channels where client_id = $1 and is_active`, [clientId])
  await db.query(`update channels set name = 'renamed' where id = $1`, [rows[0].id])
  await db.query(`update channels set is_active = true where id = $1`, [rows[0].id])
  await turnOff(rows[0].id)
})
