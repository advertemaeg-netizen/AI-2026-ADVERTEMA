import { afterAll, beforeAll, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from '../harness/stack'

// The rule lives in the database, so it is tested there: plain SQL on PGlite,
// no PostgREST or supabase-js in between.
let db: PGlite
let clientId: string
let conversationId: string

beforeAll(async () => {
  db = await createDatabase()
  const one = async (sql: string, params: unknown[] = []) => (await db.query<{ id: string }>(sql, params)).rows[0].id
  const orgId = await one(`insert into organizations (name, slug) values ('Org', 'org') returning id`)
  clientId = await one(`insert into clients (organization_id, name, slug) values ($1, 'Client', 'client') returning id`, [orgId])
  const channelId = await one(`insert into channels (client_id, type, name) values ($1, 'website', 'Website') returning id`, [clientId])
  conversationId = await one(
    `insert into conversations (client_id, channel_id, contact_identifier, status) values ($1, $2, 'visitor-index', 'new') returning id`,
    [clientId, channelId]
  )
})

afterAll(() => db.close())

const insertLead = (status: string) =>
  db.query<{ id: string }>(`insert into leads (client_id, conversation_id, status) values ($1, $2, $3) returning id`, [
    clientId,
    conversationId,
    status,
  ])

const refused = { code: '23505', message: expect.stringContaining('one_open_lead_per_conversation') }

it('allows one open lead per conversation, and a new one only once it is closed', async () => {
  const first = (await insertLead('new')).rows[0].id

  // A second open lead, whatever its status, is refused by the index
  for (const status of ['new', 'contacted', 'appointment_booked']) {
    await expect(insertLead(status)).rejects.toMatchObject(refused)
  }

  // Closed leads never count: the conversation's history can hold any number
  await insertLead('lost')
  await insertLead('no_show')

  // Once the open lead is closed, the returning customer gets a new one — and only one
  await db.query(`update leads set status = 'showed_up' where id = $1`, [first])
  await insertLead('new')
  await expect(insertLead('new')).rejects.toMatchObject(refused)

  // Reopening a closed lead next to the open one is refused too
  await expect(db.query(`update leads set status = 'contacted' where id = $1`, [first])).rejects.toMatchObject(refused)

  const { rows } = await db.query<{ status: string; n: number }>(
    `select status::text, count(*)::int as n from leads where conversation_id = $1 group by status order by status`,
    [conversationId]
  )
  expect(rows).toEqual([
    { status: 'lost', n: 1 },
    { status: 'new', n: 1 },
    { status: 'no_show', n: 1 },
    { status: 'showed_up', n: 1 },
  ])
})
