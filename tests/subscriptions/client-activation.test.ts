import { randomUUID } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setClientSubscriptionActive } from '@/lib/actions/admin-subscriptions'
import { createUser, seedClient, serviceClient, userClient, type TestUser } from '../harness/helpers'

/**
 * A SUPER ADMIN ACTIVATES ANY CLIENT, DIRECTLY (20261107100000).
 *
 * Found on 1 November 2026, the first day a real client's trial ended: the
 * bot answered with the fallback, and the only way back was an invoice
 * marked paid, which nobody knew was there. No test had ever run past a
 * trial's end. These do, for an agency's client and for a direct business.
 *
 * HOW THE TRIAL IS ENDED: by writing trial_ends_at and current_period_end
 * into the past, NOT by moving the clock. The test database (PGlite) reads
 * the real wall clock for now() and does not follow vi.setSystemTime, and
 * the bot's gate (client_subscription_usable) compares trial_ends_at to the
 * database's now(). Writing the dates back is the exact condition production
 * reaches on the day a trial ends. Faking time in JavaScript instead would
 * leave the database inside a live trial, and every assertion below would
 * pass without testing anything. Don't "improve" this into vi.setSystemTime.
 */

// The session the action sees: the user's real JWT, so RLS and auth.uid() apply as in production
const session = { user: null as TestUser | null, impersonating: false }
const signInAs = (user: TestUser | null, impersonating = false) => Object.assign(session, { user, impersonating })

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({
    supabase: session.user ? userClient(session.user.id) : serviceClient(),
    profile: session.user,
    impersonation: session.impersonating ? { organizationId: session.user!.organization_id } : null,
  }),
  isImpersonating: async () => session.impersonating,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const service = serviceClient()
const DAY = 24 * 60 * 60 * 1000

type Kind = { label: string; seed: () => Promise<{ organizationId: string; clientId: string }> }

/** An agency (the default organization type) with one client */
const agencyClient: Kind = { label: 'an agency’s client', seed: () => seedClient() }

/** A direct business: its organization and its one client */
const directBusiness: Kind = {
  label: 'a direct business',
  seed: async () => {
    const tag = randomUUID().slice(0, 8)
    const { data: org, error } = await service
      .from('organizations')
      .insert({ name: `Clinic ${tag}`, slug: `clinic-${tag}`, org_type: 'direct' })
      .select('id')
      .single<{ id: string }>()
    if (error) throw new Error(error.message)
    const { data: client, error: clientError } = await service
      .from('clients')
      .insert({ organization_id: org.id, name: `Clinic ${tag}`, slug: `clinic-${tag}` })
      .select('id')
      .single<{ id: string }>()
    if (clientError) throw new Error(clientError.message)
    return { organizationId: org.id, clientId: client.id }
  },
}

type Subscription = {
  status: string
  plan_id: string
  trial_ends_at: string | null
  current_period_start: string
  current_period_end: string
  messages_period_start: string
  messages_used: number
  lead_capture_used: number
  channels_used: number
  knowledge_docs_used: number
  knowledge_chunks_used: number
  team_members_used: number
  notes: string | null
}

async function subscription(clientId: string): Promise<Subscription> {
  const { data, error } = await service.from('client_subscriptions').select('*').eq('client_id', clientId).single<Subscription>()
  if (error) throw new Error(error.message)
  return data
}

/** What the bot reads before it answers (reply.ts → checkClientLimit) */
async function botGate(clientId: string): Promise<string> {
  const { data, error } = await service.rpc('check_client_limit', { p_client_id: clientId, p_limit_type: 'messages' })
  if (error) throw new Error(error.message)
  return (data as { reason: string }).reason
}

/** The trial ended a day ago: see the header for why the dates move and the clock doesn't */
async function endTrial(clientId: string) {
  const past = new Date(Date.now() - DAY).toISOString()
  const { error } = await service
    .from('client_subscriptions')
    .update({ trial_ends_at: past, current_period_end: past })
    .eq('client_id', clientId)
  if (error) throw new Error(error.message)
}

async function events(clientId: string) {
  const { data, error } = await service
    .from('client_subscription_events')
    .select('action, from_status, to_status, period_end, note, changed_by')
    .eq('client_id', clientId)
  if (error) throw new Error(error.message)
  return data
}

async function planId(slug: string) {
  const { data } = await service.from('plans').select('id').eq('slug', slug).single<{ id: string }>()
  return data!.id
}

let superAdmin: TestUser

beforeAll(async () => {
  superAdmin = await createUser('super_admin', null, 'Platform admin')
})

beforeEach(() => signInAs(null))

describe.each([agencyClient, directBusiness])('$label, after its trial has ended', ({ seed }) => {
  let clientId: string

  beforeEach(async () => {
    ;({ clientId } = await seed())
    await endTrial(clientId)
  })

  it('is blocked, and a super admin activates it with both fields blank', async () => {
    // Usage, and a custom price, that activation must leave exactly as they are
    await service.from('client_subscriptions').update({ messages_used: 7, lead_capture_used: 3 }).eq('client_id', clientId)
    const before = await subscription(clientId)
    await service.from('client_custom_pricing').insert({
      client_id: clientId,
      plan_id: before.plan_id,
      discount_type: 'fixed_price',
      fixed_price_monthly: 123,
      reason: 'negotiated',
    })
    const { data: priceBefore } = await service.from('client_custom_pricing').select('*').eq('client_id', clientId).single()
    expect(await botGate(clientId)).toBe('inactive')

    signInAs(superAdmin)
    expect(await setClientSubscriptionActive(clientId, { active: true, period_end: null, note: null })).toEqual({ ok: true })

    expect(await botGate(clientId)).toBe('ok')
    const after = await subscription(clientId)
    expect(after.status).toBe('active')
    // Status and period only
    const untouched = (s: Subscription) => ({ ...s, status: null, current_period_start: null, current_period_end: null })
    expect(untouched(after)).toMatchObject({ ...untouched(before), updated_at: expect.anything() })
    const { data: priceAfter } = await service.from('client_custom_pricing').select('*').eq('client_id', clientId).single()
    expect(priceAfter).toEqual(priceBefore)
    // Blank end date: the period runs to the next monthly message reset, never a date already past
    expect(Date.parse(after.current_period_end)).toBeGreaterThan(Date.now())

    expect(await events(clientId)).toEqual([
      {
        action: 'activate',
        from_status: 'trialing',
        to_status: 'active',
        period_end: expect.any(String),
        note: null,
        changed_by: superAdmin.id,
      },
    ])
  })

  // INTENDED BEHAVIOUR, NOT A DEFECT: changing a plan tier and paying are
  // different events. If a plan change activated a subscription, any client
  // on an expired trial could activate itself by picking a bigger plan.
  it('stays blocked when its plan is changed: a plan change is not a payment and must never activate a subscription', async () => {
    const { data, error } = await userClient(superAdmin.id).rpc('change_client_plan', {
      p_client_id: clientId,
      p_plan_id: await planId('business_plus'),
    })
    expect(error).toBeNull()
    expect(data).toBe('ok')

    expect((await subscription(clientId)).status).toBe('trialing')
    expect(await botGate(clientId)).toBe('inactive')
  })

  it('takes an end date and a note, and is deactivated and activated again from the same place', async () => {
    signInAs(superAdmin)
    const end = new Date(Date.now() + 20 * DAY).toISOString()
    expect(await setClientSubscriptionActive(clientId, { active: true, period_end: end, note: 'paid in cash' })).toEqual({ ok: true })
    expect(Date.parse((await subscription(clientId)).current_period_end)).toBe(Date.parse(end))

    expect(await setClientSubscriptionActive(clientId, { active: false, period_end: null, note: 'refunded' })).toEqual({ ok: true })
    expect(await botGate(clientId)).toBe('inactive')
    const cancelled = await subscription(clientId)
    expect(cancelled.status).toBe('cancelled')
    // Ended now, not on the date it was activated until
    expect(Date.parse(cancelled.current_period_end)).toBeLessThanOrEqual(Date.now() + 1000)

    // Nothing left to deactivate
    expect(await setClientSubscriptionActive(clientId, { active: false, period_end: null, note: null })).toEqual({
      ok: false,
      error: 'invalidStatus',
    })

    expect(await setClientSubscriptionActive(clientId, { active: true, period_end: null, note: null })).toEqual({ ok: true })
    expect(await botGate(clientId)).toBe('ok')

    // Every change recorded with who made it. Compared as a set: the test
    // database's clock can't be trusted to order rows (AGENTS.md)
    const recorded = await events(clientId)
    expect(recorded).toHaveLength(3)
    expect(recorded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'activate', from_status: 'trialing', to_status: 'active', note: 'paid in cash' }),
        expect.objectContaining({ action: 'deactivate', from_status: 'active', to_status: 'cancelled', note: 'refunded' }),
        expect.objectContaining({ action: 'activate', from_status: 'cancelled', to_status: 'active', note: null }),
      ])
    )
    expect(recorded.every((e) => e.changed_by === superAdmin.id)).toBe(true)
  })

  it('refuses an end date already past, and changes nothing', async () => {
    signInAs(superAdmin)
    const yesterday = new Date(Date.now() - DAY).toISOString()
    expect(await setClientSubscriptionActive(clientId, { active: true, period_end: yesterday, note: null })).toMatchObject({
      ok: false,
      error: 'validation',
    })
    // The database refuses it too, whoever calls
    const { data } = await userClient(superAdmin.id).rpc('set_client_subscription_active', {
      p_client_id: clientId,
      p_active: true,
      p_period_end: yesterday,
    })
    expect(data).toBe('invalid')
    expect((await subscription(clientId)).status).toBe('trialing')
    expect(await events(clientId)).toEqual([])
  })
})

describe('only a super admin activates or deactivates', () => {
  it('refuses the agency’s admin, the client’s own admin, a direct business’s owner, an impersonating super admin and the service role', async () => {
    const agency = await seedClient()
    const direct = await directBusiness.seed()
    await endTrial(agency.clientId)
    await endTrial(direct.clientId)

    const agencyAdmin = await createUser('org_admin', agency.organizationId, 'Agency admin')
    const clientAdmin = await createUser('client_admin', agency.organizationId, 'Client admin')
    await service.from('client_members').insert({ client_id: agency.clientId, user_id: clientAdmin.id, role: 'client_admin' })
    const owner = await createUser('org_admin', direct.organizationId, 'Clinic owner')
    await service.from('client_members').insert({ client_id: direct.clientId, user_id: owner.id, role: 'client_admin' })
    const impersonator = await createUser('super_admin', null, 'Impersonating admin')
    await service.from('impersonation_sessions').insert({ super_admin_id: impersonator.id, target_organization_id: agency.organizationId })

    const attempts: [TestUser, string][] = [
      [agencyAdmin, agency.clientId],
      [clientAdmin, agency.clientId],
      [owner, direct.clientId],
    ]
    for (const [user, clientId] of attempts) {
      // Through the action
      signInAs(user)
      expect(await setClientSubscriptionActive(clientId, { active: true, period_end: null, note: null })).toEqual({
        ok: false,
        error: 'forbidden',
      })
      // And straight at the database, past the action
      const { data } = await userClient(user.id).rpc('set_client_subscription_active', { p_client_id: clientId, p_active: true })
      expect(data).toBe('forbidden')
    }

    signInAs(impersonator, true)
    expect(await setClientSubscriptionActive(agency.clientId, { active: true, period_end: null, note: null })).toEqual({
      ok: false,
      error: 'impersonating',
    })
    // The database sees an impersonating super admin as the org admin they are viewing as
    const { data: asImpersonator } = await userClient(impersonator.id).rpc('set_client_subscription_active', {
      p_client_id: agency.clientId,
      p_active: true,
    })
    expect(asImpersonator).toBe('forbidden')

    // No auth.uid(): nobody to record, so nobody may
    const { data: asService } = await service.rpc('set_client_subscription_active', { p_client_id: agency.clientId, p_active: true })
    expect(asService).toBe('forbidden')

    for (const clientId of [agency.clientId, direct.clientId]) {
      expect((await subscription(clientId)).status).toBe('trialing')
      expect(await botGate(clientId)).toBe('inactive')
      expect(await events(clientId)).toEqual([])
    }
  })

  it('keeps the record of changes from everyone else', async () => {
    const { organizationId, clientId } = await seedClient()
    signInAs(superAdmin)
    expect(await setClientSubscriptionActive(clientId, { active: true, period_end: null, note: null })).toEqual({ ok: true })

    const agencyAdmin = await createUser('org_admin', organizationId, 'Agency admin')
    const { data } = await userClient(agencyAdmin.id).from('client_subscription_events').select('id').eq('client_id', clientId)
    expect(data ?? []).toEqual([])
    const { data: asSuper } = await userClient(superAdmin.id).from('client_subscription_events').select('id').eq('client_id', clientId)
    expect(asSuper).toHaveLength(1)
  })
})

describe('the other way in: paying', () => {
  it('activates a direct business after its trial has ended when a super admin marks its invoice paid', async () => {
    const { organizationId, clientId } = await directBusiness.seed()
    await endTrial(clientId)
    expect(await botGate(clientId)).toBe('inactive')

    // Billed to the organization; the database files it under its one client
    const { data: invoice, error } = await service
      .from('invoices')
      .insert({
        organization_id: organizationId,
        amount: 500,
        period_start: new Date().toISOString(),
        period_end: new Date(Date.now() + 30 * DAY).toISOString(),
        status: 'sent',
      })
      .select('id, client_id')
      .single<{ id: string; client_id: string }>()
    if (error) throw new Error(error.message)
    expect(invoice.client_id).toBe(clientId)

    const { data } = await userClient(superAdmin.id).rpc('mark_invoice_paid', {
      p_invoice_id: invoice.id,
      p_payment_method: 'bank_transfer',
      p_payment_reference: '',
    })
    expect(data).toBe('ok')
    expect(await botGate(clientId)).toBe('ok')
  })
})
