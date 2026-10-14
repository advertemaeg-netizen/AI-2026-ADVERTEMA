import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addClosuresAction,
  createBranchAction,
  deleteBranchAction,
  deleteClosureAction,
  getBranches,
  updateBranchAction,
} from '@/lib/actions/branches'
import { canManageClient } from '@/lib/auth/permissions'
import { DEFAULT_BRANCH_INPUT, uniformWeek, type BranchInput } from '@/lib/types/branches'
import { createUser, interceptRest, seedClient, serviceClient, uniqueViolation, userClient, type TestUser } from '../harness/helpers'

// The session the actions see: a real signed-in client (the user's JWT, so
// RLS applies as in production) and the profile getSession() would load.
const session = { user: null as TestUser | null, impersonating: false }
const signInAs = (user: TestUser | null, impersonating = false) => Object.assign(session, { user, impersonating })

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({
    supabase: session.user ? userClient(session.user.id) : serviceClient(),
    profile: session.user,
    impersonation: session.impersonating ? { organizationId: session.user!.organization_id } : null,
  }),
  isImpersonating: async () => session.impersonating,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const admin = serviceClient()

// The demo clinic's two branches, as its knowledge base describes them
const MAADI: BranchInput = { ...DEFAULT_BRANCH_INPUT, name: 'المعادي', business_hours: { ...uniformWeek('12:00', '22:00'), fri: [['15:00', '22:00']] } }
const TAGAMMU: BranchInput = { ...DEFAULT_BRANCH_INPUT, name: 'التجمع الخامس', business_hours: uniformWeek('13:00', '22:00', ['fri']) }

type World = Awaited<ReturnType<typeof seedClient>> & { orgAdmin: TestUser; teamMember: TestUser; outsider: TestUser }
let world: World

beforeEach(async () => {
  signInAs(null)
  const seeded = await seedClient()
  const other = await seedClient()
  world = {
    ...seeded,
    orgAdmin: await createUser('org_admin', seeded.organizationId, 'مدير'),
    teamMember: await createUser('team_member', seeded.organizationId, 'عضو'),
    outsider: await createUser('org_admin', other.organizationId, 'غريب'),
  }
})

async function branchesInDb() {
  const { data } = await admin.from('branches').select('id, name, business_hours, is_active').eq('client_id', world.clientId).order('created_at')
  return data!
}

async function addLead(fields: Record<string, unknown>) {
  const { data, error } = await admin.from('leads').insert({ client_id: world.clientId, ...fields }).select('id').single<{ id: string }>()
  if (error) throw new Error(error.message)
  return data.id
}

describe('adding and editing a branch', () => {
  it('saves a branch with its own week, and links the leads that named it', async () => {
    const named = await addLead({ branch: 'فرع المعادى' })
    signInAs(world.orgAdmin)

    expect(await createBranchAction(world.clientId, MAADI)).toEqual({ ok: true, linkedLeads: 1 })
    const [saved] = await branchesInDb()
    expect(saved).toMatchObject({ name: 'المعادي', business_hours: MAADI.business_hours })
    const { data: lead } = await admin.from('leads').select('branch_id').eq('id', named).single()
    expect(lead!.branch_id).toBe(saved.id)
  })

  it('links the leads that named a branch once it is renamed to that name', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, { ...DEFAULT_BRANCH_INPUT, name: 'الفرع الرئيسي' })
    const [branch] = await branchesInDb()
    await addLead({ branch: 'المعادي' })

    expect(await updateBranchAction(branch.id, MAADI)).toEqual({ ok: true, linkedLeads: 1 })
  })

  it('refuses hours that overlap, or open and close at the same minute, and says which day', async () => {
    signInAs(world.orgAdmin)
    const overlapping = { ...MAADI, business_hours: { ...MAADI.business_hours!, sat: [['12:00', '18:00'], ['17:00', '22:00']] as [string, string][] } }
    expect(await createBranchAction(world.clientId, overlapping)).toMatchObject({
      ok: false,
      error: 'validation',
      fieldErrors: { 'business_hours.sat': 'overlap' },
    })
    const empty = { ...MAADI, business_hours: { ...MAADI.business_hours!, sun: [['12:00', '12:00']] as [string, string][] } }
    expect(await createBranchAction(world.clientId, empty)).toMatchObject({ ok: false, fieldErrors: { 'business_hours.sun.0': 'emptyRange' } })
    expect(await branchesInDb()).toEqual([])
  })

  it('accepts a split day and a range past midnight, as Ramadan hours are', async () => {
    signInAs(world.orgAdmin)
    const ramadan = { ...MAADI, business_hours: { ...MAADI.business_hours!, sat: [['14:00', '17:00'], ['20:00', '01:00']] as [string, string][] } }
    expect(await createBranchAction(world.clientId, ramadan)).toMatchObject({ ok: true })
  })

  it('tells the team when another branch already has the name', async () => {
    signInAs(world.orgAdmin)
    // A real 23505 over REST drops pglite's connection (helpers.ts): PostgREST's answer, as it would come
    interceptRest({ path: '/branches', method: 'POST' }, () => uniqueViolation('branches_client_name'))
    expect(await createBranchAction(world.clientId, MAADI)).toMatchObject({ ok: false, error: 'duplicateName', fieldErrors: { name: 'duplicateName' } })
  })

  it('lets a team member change nothing, and an admin of another organization not even find the client', async () => {
    signInAs(world.teamMember)
    expect(await createBranchAction(world.clientId, MAADI)).toEqual({ ok: false, error: 'forbidden' })
    signInAs(world.outsider)
    expect(await createBranchAction(world.clientId, MAADI)).toEqual({ ok: false, error: 'notFound' })
    signInAs(world.orgAdmin, true)
    expect(await createBranchAction(world.clientId, MAADI)).toEqual({ ok: false, error: 'impersonating' })
    expect(await branchesInDb()).toEqual([])
  })

  it('does not let an admin of another organization edit a branch it cannot see', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, MAADI)
    const [branch] = await branchesInDb()
    signInAs(world.outsider)
    expect(await updateBranchAction(branch.id, { ...MAADI, name: 'تم الاختراق' })).toEqual({ ok: false, error: 'notFound' })
    expect((await branchesInDb())[0].name).toBe('المعادي')
  })
})

describe('deleting a branch', () => {
  it('deletes a branch nobody was booked at, and keeps one with leads, which is deactivated instead', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, MAADI)
    await createBranchAction(world.clientId, TAGAMMU)
    const [maadi, tagammu] = await branchesInDb()
    await addLead({ branch_id: maadi.id })

    expect(await deleteBranchAction(maadi.id)).toEqual({ ok: false, error: 'hasLeads' })
    expect(await deleteBranchAction(tagammu.id)).toEqual({ ok: true })
    expect((await branchesInDb()).map((b) => b.name)).toEqual(['المعادي'])
  })
})

describe('closed days', () => {
  it('closes every chosen branch on every day of the span, and a day already closed stays as it was', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, MAADI)
    await createBranchAction(world.clientId, TAGAMMU)
    const ids = (await branchesInDb()).map((b) => b.id)

    // Eid al-Adha 2027, both branches
    const eid = { from: '2027-05-16', to: '2027-05-17', reason: 'عيد الأضحى', branchIds: ids }
    expect(await addClosuresAction(world.clientId, eid)).toEqual({ ok: true, added: 4 })
    expect(await addClosuresAction(world.clientId, { ...eid, reason: 'تاني' })).toEqual({ ok: true, added: 0 })

    const { data } = await admin.from('branch_closures').select('date, reason').eq('client_id', world.clientId).order('date')
    expect(data).toHaveLength(4)
    expect(new Set(data!.map((c) => c.reason))).toEqual(new Set(['عيد الأضحى']))
  })

  it('refuses a span that ends before it starts, or runs past 31 days', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, MAADI)
    const [branch] = await branchesInDb()
    expect(await addClosuresAction(world.clientId, { from: '2027-05-17', to: '2027-05-16', reason: '', branchIds: [branch.id] })).toMatchObject({
      ok: false,
      fieldErrors: { to: 'endBeforeStart' },
    })
    expect(await addClosuresAction(world.clientId, { from: '2027-01-01', to: '2027-02-15', reason: '', branchIds: [branch.id] })).toMatchObject({
      ok: false,
      fieldErrors: { to: 'spanTooLong' },
    })
  })

  it('will not close another client\'s branch through this client', async () => {
    const other = await seedClient()
    const { data: theirs } = await admin.from('branches').insert({ client_id: other.clientId, name: 'المعادي' }).select('id').single()
    signInAs(world.orgAdmin)
    expect(await addClosuresAction(world.clientId, { from: '2027-05-16', to: '2027-05-16', reason: '', branchIds: [theirs!.id] })).toEqual({
      ok: false,
      error: 'notFound',
    })
  })

  it('removes one closed day', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, MAADI)
    const [branch] = await branchesInDb()
    await addClosuresAction(world.clientId, { from: '2027-05-16', to: '2027-05-16', reason: '', branchIds: [branch.id] })
    const { data: closure } = await admin.from('branch_closures').select('id').eq('branch_id', branch.id).single()
    expect(await deleteClosureAction(closure!.id)).toEqual({ ok: true })
  })
})

describe('the page\'s list', () => {
  it('shows each branch with its upcoming closed days, its leads and its upcoming appointments', async () => {
    signInAs(world.orgAdmin)
    await createBranchAction(world.clientId, MAADI)
    await createBranchAction(world.clientId, { ...TAGAMMU, is_active: false })
    const [maadi, tagammu] = await branchesInDb()
    await addClosuresAction(world.clientId, { from: '2099-05-16', to: '2099-05-16', reason: 'عيد', branchIds: [maadi.id] })
    await addLead({ branch_id: tagammu.id, appointment_at: '2099-01-01T10:00:00Z' })
    await addLead({ branch_id: tagammu.id, appointment_at: '2020-01-01T10:00:00Z' })

    const branches = await getBranches(world.clientId)
    expect(branches.map((b) => [b.name, b.closures.length, b.leadCount, b.upcomingCount])).toEqual([
      ['المعادي', 1, 0, 0],
      ['التجمع الخامس', 0, 2, 1],
    ])

    signInAs(world.teamMember)
    expect(await getBranches(world.clientId)).toEqual([])
  })
})
