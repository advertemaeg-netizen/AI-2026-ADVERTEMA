import { describe, expect, it } from 'vitest'
import { createUser, seedClient, serviceClient, userClient } from '../harness/helpers'

/**
 * The branches migration (20261028100000): the shape the database accepts,
 * the conversion of today's opening hours, and the link from leads by name.
 * The suite's database is migrated empty, so the seed of one branch per
 * client never sees a row here: its conversion is the function tested below.
 */

const OPEN_WEEK = {
  sat: [['12:00', '22:00']],
  sun: [['12:00', '22:00']],
  mon: [['12:00', '22:00']],
  tue: [['12:00', '22:00']],
  wed: [['12:00', '22:00']],
  thu: [['12:00', '22:00']],
  fri: [['15:00', '22:00']],
}

const rpc = async <T>(fn: string, args: Record<string, unknown>) => {
  const { data, error } = await serviceClient().rpc(fn, args)
  if (error) throw new Error(`${fn}: ${error.message}`)
  return data as T
}

/**
 * The SQLSTATE the database refuses `statement` with, or null. Through
 * test_sqlstate, not REST: on pglite a failed statement over REST drops the
 * connection and comes back as PGRST001, never as the code (helpers.ts).
 */
const refusal = (statement: string) => rpc<string | null>('test_sqlstate', { statement })
const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'`

async function addBranch(clientId: string, name: string, extra: Record<string, unknown> = {}) {
  const { data, error } = await serviceClient()
    .from('branches')
    .insert({ client_id: clientId, name, ...extra })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`adding branch ${name}: ${error.message}`)
  return data.id
}

async function addLead(clientId: string, fields: Record<string, unknown>) {
  const { data, error } = await serviceClient()
    .from('leads')
    .insert({ client_id: clientId, ...fields })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`adding lead: ${error.message}`)
  return data.id
}

describe('a branch name as people type it', () => {
  it.each([
    ['فرع المعادي', 'المعادي'],
    ['  المعادى ', 'المعادي'],
    ['التجمع  الخامس', 'التجمع الخامس'],
    ['فرع الإسكندرية', 'الاسكندريه'],
    ['Main Branch', 'main branch'],
  ])('reads "%s" as "%s"', async (name, folded) => {
    expect(await rpc('normalize_branch_name', { name })).toBe(folded)
  })

  it('has no name left when there is nothing but "فرع" and spaces', async () => {
    expect(await rpc('normalize_branch_name', { name: ' فرع ' })).toBe('فرع')
    expect(await rpc('normalize_branch_name', { name: '   ' })).toBeNull()
  })
})

describe('the hours a branch may hold', () => {
  it.each([
    ['an ordinary week', OPEN_WEEK],
    ['a day closed', { ...OPEN_WEEK, fri: [] }],
    ['a split day', { ...OPEN_WEEK, sat: [['10:00', '14:00'], ['17:00', '22:00']] }],
    ['a range past midnight', { ...OPEN_WEEK, thu: [['20:00', '01:00']] }],
  ])('accepts %s', async (_, hours) => {
    expect(await rpc('valid_branch_hours', { hours })).toBe(true)
  })

  it.each([
    ['a weekday missing', Object.fromEntries(Object.entries(OPEN_WEEK).filter(([day]) => day !== 'fri'))],
    ['a key that is not a weekday', { ...OPEN_WEEK, holiday: [] }],
    ['a day that is not a list', { ...OPEN_WEEK, sun: { from: '12:00', to: '22:00' } }],
    ['a range with one end', { ...OPEN_WEEK, sun: [['12:00']] }],
    ['a clock that is not HH:MM', { ...OPEN_WEEK, sun: [['12', '22:00']] }],
    ['an hour past 23', { ...OPEN_WEEK, sun: [['12:00', '24:00']] }],
    ['a range that opens and closes at the same minute', { ...OPEN_WEEK, sun: [['12:00', '12:00']] }],
  ])('refuses %s', async (_, hours) => {
    expect(await rpc('valid_branch_hours', { hours })).toBe(false)
  })
})

describe('today\'s opening hours become the first branch\'s', () => {
  const day = (open: boolean, from = '12:00', to = '22:00') => ({ open, from, to })
  const settings = {
    enabled: true,
    timezone: 'Africa/Cairo',
    days: {
      sat: day(true), sun: day(true), mon: day(true), tue: day(true), wed: day(true), thu: day(true), fri: day(true, '15:00'),
    },
  }

  it('converts each day to its range, as the demo clinic\'s are today', async () => {
    expect(await rpc('branch_hours_from_settings', { old: settings })).toEqual(OPEN_WEEK)
  })

  it('turns a closed day into an empty list', async () => {
    const hours = await rpc<Record<string, unknown>>('branch_hours_from_settings', {
      old: { ...settings, days: { ...settings.days, fri: day(false) } },
    })
    expect(hours.fri).toEqual([])
  })

  it.each([
    ['hours turned off', { ...settings, enabled: false }],
    ['no hours at all', null],
    ['a day the new check refuses', { ...settings, days: { ...settings.days, sun: day(true, '12:00', '12:00') } }],
  ])('leaves the hours not set for %s', async (_, old) => {
    expect(await rpc('branch_hours_from_settings', { old })).toBeNull()
  })
})

describe('branches of a client', () => {
  // The user's decision, 2026-10-14: a client is never silently without a
  // branch. The one it starts with confirms nothing until its hours are set.
  it('gives every new client one branch, with defaults that never confirm: hours not set, one visitor per 30-minute slot', async () => {
    const { clientId } = await seedClient()
    const { data } = await serviceClient().from('branches').select('*').eq('client_id', clientId)
    expect(data).toEqual([
      expect.objectContaining({
        name: 'الفرع الرئيسي',
        business_hours: null,
        capacity_per_slot: 1,
        slot_minutes: 30,
        is_active: true,
        timezone: 'Africa/Cairo',
      }),
    ])
  })

  it('refuses a second branch whose name reads the same, and a shape of hours it cannot read', async () => {
    const { clientId } = await seedClient()
    await addBranch(clientId, 'المعادي')
    expect(await refusal(`insert into public.branches (client_id, name) values ('${clientId}', 'فرع المعادى')`)).toBe('23505')
    expect(
      await refusal(
        `insert into public.branches (client_id, name, business_hours) values ('${clientId}', 'التجمع', ${quote({ sat: [['13:00', '22:00']] })})`
      )
    ).toBe('23514')
  })

  it('lets two clients each have a branch of the same name', async () => {
    const a = await seedClient()
    const b = await seedClient()
    await addBranch(a.clientId, 'المعادي')
    await expect(addBranch(b.clientId, 'المعادي')).resolves.toBeTruthy()
  })
})

describe('a lead and its branch', () => {
  it('cannot point at another client\'s branch', async () => {
    const mine = await seedClient()
    const theirs = await seedClient()
    const theirBranch = await addBranch(theirs.clientId, 'المعادي')
    expect(await refusal(`insert into public.leads (client_id, branch_id) values ('${mine.clientId}', '${theirBranch}')`)).toBe('23503')
  })

  it('keeps a branch that has leads: it is deactivated, not deleted', async () => {
    const { clientId } = await seedClient()
    const branch = await addBranch(clientId, 'المعادي')
    await addLead(clientId, { branch_id: branch })
    expect(await refusal(`delete from public.branches where id = '${branch}'`)).toBe('23503')
  })

  it('goes with its client: deleting a client with branches and leads on them is not blocked', async () => {
    const { clientId } = await seedClient()
    await addLead(clientId, { branch_id: await addBranch(clientId, 'المعادي') })
    expect(await refusal(`delete from public.clients where id = '${clientId}'`)).toBeNull()
  })

  it('links the client\'s unplaced leads whose branch reads as the branch\'s name, and nothing else', async () => {
    const { clientId } = await seedClient()
    const other = await seedClient()
    const maadi = await addBranch(clientId, 'المعادي')
    const tagammu = await addBranch(clientId, 'التجمع الخامس')

    const written = await addLead(clientId, { branch: 'فرع المعادى' })
    const elsewhere = await addLead(clientId, { branch: 'التجمع' })
    const none = await addLead(clientId, {})
    const placed = await addLead(clientId, { branch: 'المعادي', branch_id: tagammu })
    const otherClient = await addLead(other.clientId, { branch: 'المعادي' })

    expect(await rpc('link_leads_to_branch', { p_branch_id: maadi })).toBe(1)

    const { data } = await serviceClient().from('leads').select('id, branch_id').in('id', [written, elsewhere, none, placed, otherClient])
    const branchOf = Object.fromEntries((data ?? []).map((lead) => [lead.id, lead.branch_id]))
    expect(branchOf).toEqual({ [written]: maadi, [elsewhere]: null, [none]: null, [placed]: tagammu, [otherClient]: null })
  })
})

describe('closures', () => {
  it('holds one row per branch and day, and goes with the branch', async () => {
    const { clientId } = await seedClient()
    const branch = await addBranch(clientId, 'المعادي')
    const closure = `insert into public.branch_closures (client_id, branch_id, date, reason) values ('${clientId}', '${branch}', '2026-03-20', 'عيد الفطر')`
    expect(await refusal(closure)).toBeNull()
    expect(await refusal(closure)).toBe('23505')

    expect((await serviceClient().from('branches').delete().eq('id', branch)).error).toBeNull()
    const { count } = await serviceClient().from('branch_closures').select('id', { count: 'exact', head: true }).eq('branch_id', branch)
    expect(count).toBe(0)
  })
})

describe('who sees and manages branches', () => {
  it('lets the organization\'s admin manage them, and nobody outside it see them', async () => {
    const { clientId, organizationId } = await seedClient()
    const outsider = await seedClient()
    const admin = await createUser('org_admin', organizationId, 'Admin')
    const stranger = await createUser('org_admin', outsider.organizationId, 'Stranger')

    const { error } = await userClient(admin.id).from('branches').insert({ client_id: clientId, name: 'المعادي' })
    expect(error).toBeNull()
    const seen = await userClient(admin.id).from('branches').select('name').eq('client_id', clientId).order('created_at')
    expect(seen.data).toEqual([{ name: 'الفرع الرئيسي' }, { name: 'المعادي' }])

    const hidden = await userClient(stranger.id).from('branches').select('name').eq('client_id', clientId)
    expect(hidden.data).toEqual([])
  })
})
