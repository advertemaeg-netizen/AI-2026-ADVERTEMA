import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import type { PGlite } from '@electric-sql/pglite'
import { createDatabase } from '../harness/stack'

// change_client_plan() is a database function: tested with plain SQL on
// PGlite, signed in as a super admin through the JWT claims it reads.
let db: PGlite
let organizationId: string
let clientId: string
let plans: Record<'business_basic' | 'business_plus', { id: string; limit: number }>

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows

beforeAll(async () => {
  db = await createDatabase()
  const [admin] = await rows<{ id: string }>(`insert into auth.users (email) values ('admin@example.com') returning id`)
  await db.query(`update users set role = 'super_admin' where id = $1`, [admin.id])
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: admin.id, role: 'authenticated' })])

  const found = await rows<{ slug: string; id: string; messages_limit: number }>(
    `select slug, id, messages_limit from plans where slug in ('business_basic', 'business_plus')`
  )
  plans = Object.fromEntries(found.map((p) => [p.slug, { id: p.id, limit: p.messages_limit }])) as typeof plans
  expect(plans.business_plus.limit).toBeGreaterThan(plans.business_basic.limit)
})

afterAll(() => db.close())

// A fresh client on business_basic (the default trial plan)
beforeEach(async () => {
  const tag = Math.random().toString(36).slice(2, 10)
  ;[{ id: organizationId }] = await rows<{ id: string }>(
    `insert into organizations (name, slug) values ($1, $1) returning id`,
    [`org-${tag}`]
  )
  ;[{ id: clientId }] = await rows<{ id: string }>(
    `insert into clients (organization_id, name, slug) values ($1, 'Client', $2) returning id`,
    [organizationId, `client-${tag}`]
  )
})

const changePlan = async (plan: keyof typeof plans) =>
  (await rows<{ result: string }>(`select change_client_plan($1, $2) as result`, [clientId, plans[plan].id]))[0].result

const setUsage = (messagesUsed: number, captureUsed = 0) =>
  db.query(`update client_subscriptions set messages_used = $2, lead_capture_used = $3 where client_id = $1`, [
    clientId,
    messagesUsed,
    captureUsed,
  ])

const subscription = async () =>
  (
    await rows<{ plan_id: string; messages_used: number; lead_capture_used: number }>(
      `select plan_id, messages_used, lead_capture_used from client_subscriptions where client_id = $1`,
      [clientId]
    )
  )[0]

const alerts = () =>
  rows<{ limit_type: string; threshold: number }>(
    `select limit_type, threshold from usage_alerts where client_id = $1 order by limit_type, threshold`,
    [clientId]
  )

it('starts the lead-capture allowance over when the client moves to a plan with more messages', async () => {
  const { limit } = plans.business_basic
  await setUsage(limit, 37)

  expect(await changePlan('business_plus')).toBe('ok')

  // The replies already used this month still count on the new plan
  expect(await subscription()).toEqual({ plan_id: plans.business_plus.id, messages_used: limit, lead_capture_used: 0 })
})

it('keeps the lead-capture count on a downgrade, and when the plan does not change', async () => {
  expect(await changePlan('business_plus')).toBe('ok')
  await setUsage(plans.business_plus.limit, 37)

  expect(await changePlan('business_plus')).toBe('ok')
  expect((await subscription()).lead_capture_used).toBe(37)

  expect(await changePlan('business_basic')).toBe('ok')
  expect(await subscription()).toMatchObject({ plan_id: plans.business_basic.id, lead_capture_used: 37 })
})

it("clears the old plan's usage alerts on a plan change, so the new plan's thresholds are raised again", async () => {
  const basic = plans.business_basic.limit
  const plus = plans.business_plus.limit
  // The whole of the old plan must sit under the new plan's first threshold
  expect(basic).toBeLessThan(0.8 * plus)

  // 100 % of the old plan: all three thresholds raised
  await setUsage(basic)
  const messages = (thresholds: number[]) => thresholds.map((threshold) => ({ limit_type: 'messages', threshold }))
  expect(await alerts()).toEqual(messages([80, 90, 100]))

  // Upgraded: under 80 % of the new plan, nothing to warn about
  expect(await changePlan('business_plus')).toBe('ok')
  expect(await alerts()).toEqual([])

  // 80 % of the new plan in the same month: raised again
  await setUsage(Math.ceil(0.8 * plus))
  expect(await alerts()).toEqual(messages([80]))

  // Downgraded while over the smaller plan: its thresholds are raised straight away
  expect(await changePlan('business_basic')).toBe('ok')
  expect(await alerts()).toEqual(messages([80, 90, 100]))
})

it("clears the AI-cost alert on a plan change: it was measured against the old plan's price", async () => {
  const price = async () =>
    Number((await rows<{ price: string }>(`select get_client_effective_price($1) as price`, [clientId]))[0].price)
  const [{ rate }] = await rows<{ rate: number }>(
    `select coalesce((select usd_to_egp from platform_settings), 50)::float as rate`
  )
  /** Logs AI usage that brings the month's cost to `egp` */
  let spent = 0
  const spendUpTo = async (egp: number) => {
    await db.query(
      `insert into ai_usage (organization_id, client_id, operation, model, estimated_cost_usd) values ($1, $2, 'chat_reply', 'test-model', $3)`,
      [organizationId, clientId, (egp - spent) / rate]
    )
    spent = egp
  }
  const aiCost = [{ limit_type: 'ai_cost', threshold: 50 }]

  // Past half of the old plan's price: the alert is raised
  const basicPrice = await price()
  await spendUpTo(0.6 * basicPrice)
  expect(await alerts()).toEqual(aiCost)

  // On the new plan the same cost is under half the price: the alert no longer holds
  expect(await changePlan('business_plus')).toBe('ok')
  const plusPrice = await price()
  expect(0.6 * basicPrice).toBeLessThan(0.5 * plusPrice)
  expect(await alerts()).toEqual([])

  // Past half of the new price in the same month: raised again
  await spendUpTo(0.6 * plusPrice)
  expect(await alerts()).toEqual(aiCost)
})
