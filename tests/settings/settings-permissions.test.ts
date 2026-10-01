import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAccountSettings, updateDisplayName, updateOrganizationName } from '@/lib/actions/settings'
import { createUser, restCalls, serviceClient, userClient, type TestUser } from '../harness/helpers'

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
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const admin = serviceClient()
const ROLES = ['org_admin', 'client_admin', 'team_member'] as const
type Role = (typeof ROLES)[number]

type World = {
  ours: { id: string; name: string }
  theirs: { id: string; name: string }
  users: Record<Role, TestUser>
  /** An admin of the other organization */
  outsider: TestUser
}
let world: World

async function createOrganization(name: string, orgType: 'agency' | 'direct' = 'agency') {
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`
  const { data, error } = await admin.from('organizations').insert({ name, slug, org_type: orgType }).select('id').single<{ id: string }>()
  if (error) throw new Error(error.message)
  return { id: data.id, name }
}

beforeEach(async () => {
  signInAs(null)
  const ours = await createOrganization('وكالتنا')
  const theirs = await createOrganization('وكالة تانية')
  world = {
    ours,
    theirs,
    users: {
      org_admin: await createUser('org_admin', ours.id, 'مدير المنظمة'),
      client_admin: await createUser('client_admin', ours.id, 'مدير العميل'),
      team_member: await createUser('team_member', ours.id, 'عضو الفريق'),
    },
    outsider: await createUser('org_admin', theirs.id, 'مدير الوكالة التانية'),
  }
})

/** Every user's name and both organizations' names, straight from the database */
async function snapshot() {
  const ids = [...Object.values(world.users), world.outsider].map((user) => user.id)
  const { data: users } = await admin.from('users').select('id, full_name, email, role, organization_id').in('id', ids).order('id')
  const { data: organizations } = await admin
    .from('organizations')
    .select('id, name, slug, org_type, is_active')
    .in('id', [world.ours.id, world.theirs.id])
    .order('id')
  return { users: users!, organizations: organizations! }
}
const nameOf = (state: Awaited<ReturnType<typeof snapshot>>, user: TestUser) =>
  state.users.find((row) => row.id === user.id)!.full_name
const orgName = (state: Awaited<ReturnType<typeof snapshot>>, id: string) =>
  state.organizations.find((row) => row.id === id)!.name

describe('what each role sees', () => {
  it('shows the organization section to organization admins only', async () => {
    signInAs(world.users.org_admin)
    expect(await getAccountSettings()).toEqual({
      full_name: 'مدير المنظمة',
      email: expect.stringContaining('@example.com'),
      organization: { name: 'وكالتنا', org_type: 'agency' },
    })

    for (const role of ['client_admin', 'team_member'] as const) {
      signInAs(world.users[role])
      const settings = await getAccountSettings()
      expect(settings).toMatchObject({ organization: null })
      expect(settings!.full_name).not.toBe('')
    }
  })

  it('shows nothing to a signed-out caller', async () => {
    signInAs(null)
    expect(await getAccountSettings()).toBeNull()
  })
})

describe('display name', () => {
  it.each(ROLES)('%s changes their own name, and nobody else is touched', async (role) => {
    const before = await snapshot()
    signInAs(world.users[role])

    expect(await updateDisplayName('  اسم جديد  ')).toEqual({ ok: true })

    const after = await snapshot()
    expect(nameOf(after, world.users[role])).toBe('اسم جديد')
    // Everything else is exactly as it was: other users, roles, emails, organizations
    const expected = structuredClone(before)
    expected.users.find((row) => row.id === world.users[role].id)!.full_name = 'اسم جديد'
    expect(after).toEqual(expected)
  })

  it('refuses a signed-out caller, an empty name, and a super admin viewing the account', async () => {
    const before = await snapshot()

    signInAs(null)
    expect(await updateDisplayName('x')).toEqual({ ok: false, error: 'unauthorized' })

    signInAs(world.users.team_member)
    expect(await updateDisplayName('   ')).toEqual({ ok: false, error: 'validation' })
    expect(await updateDisplayName('x'.repeat(101))).toEqual({ ok: false, error: 'validation' })

    signInAs(world.users.org_admin, true)
    expect(await updateDisplayName('اسم جديد')).toEqual({ ok: false, error: 'impersonating' })

    expect(await snapshot()).toEqual(before)
  })
})

describe('organization name', () => {
  it('lets an organization admin rename their own organization, and only that', async () => {
    const before = await snapshot()
    signInAs(world.users.org_admin)

    expect(await updateOrganizationName('  الاسم الجديد  ')).toEqual({ ok: true })

    const expected = structuredClone(before)
    expected.organizations.find((row) => row.id === world.ours.id)!.name = 'الاسم الجديد'
    // Same slug, type and status; the other organization untouched
    expect(await snapshot()).toEqual(expected)
  })

  it.each(['client_admin', 'team_member'] as const)(
    'refuses %s in the action itself, before the database is asked',
    async (role) => {
      const before = await snapshot()
      signInAs(world.users[role])

      expect(await updateOrganizationName('اسم مسروق')).toEqual({ ok: false, error: 'forbidden' })

      expect(restCalls.filter((call) => call.includes('rename_my_organization'))).toEqual([])
      expect(await snapshot()).toEqual(before)
    }
  )

  it('refuses a signed-out caller, an invalid name, and a super admin viewing the account', async () => {
    const before = await snapshot()

    signInAs(null)
    expect(await updateOrganizationName('اسم جديد')).toEqual({ ok: false, error: 'unauthorized' })

    signInAs(world.users.org_admin)
    expect(await updateOrganizationName(' x ')).toEqual({ ok: false, error: 'validation' })
    expect(await updateOrganizationName('x'.repeat(101))).toEqual({ ok: false, error: 'validation' })

    signInAs(world.users.org_admin, true)
    expect(await updateOrganizationName('اسم جديد')).toEqual({ ok: false, error: 'impersonating' })

    expect(await snapshot()).toEqual(before)
  })
})

describe('calling the database directly, around the actions', () => {
  it.each(['client_admin', 'team_member'] as const)('rename_my_organization refuses %s', async (role) => {
    const before = await snapshot()

    const { data, error } = await userClient(world.users[role].id).rpc('rename_my_organization', { p_name: 'اسم مسروق' })

    expect(error).toBeNull()
    expect(data).toBe('forbidden')
    expect(await snapshot()).toEqual(before)
  })

  it("rename_my_organization only ever reaches the caller's own organization", async () => {
    const { data } = await userClient(world.outsider.id).rpc('rename_my_organization', { p_name: 'اسم من برّه' })

    expect(data).toBe('ok')
    const after = await snapshot()
    expect(orgName(after, world.theirs.id)).toBe('اسم من برّه')
    expect(orgName(after, world.ours.id)).toBe('وكالتنا')
  })

  it('rename_my_organization refuses an anonymous caller and a super admin', async () => {
    const before = await snapshot()
    const superAdmin = await createUser('super_admin', world.ours.id, 'مدير المنصة')

    expect((await userClient(superAdmin.id).rpc('rename_my_organization', { p_name: 'اسم جديد' })).data).toBe('forbidden')
    // No JWT at all: the function isn't even callable
    const anonymous = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/rename_my_organization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_name: 'اسم جديد' }),
    })
    expect(anonymous.ok).toBe(false)

    const after = await snapshot()
    expect(after.organizations).toEqual(before.organizations)
  })

  it.each(ROLES)('a plain UPDATE of any organization by %s changes nothing', async (role) => {
    const before = await snapshot()
    const client = userClient(world.users[role].id)

    for (const id of [world.ours.id, world.theirs.id]) {
      const { data } = await client.from('organizations').update({ name: 'اسم مسروق', is_active: false }).eq('id', id).select('id')
      expect(data ?? []).toEqual([])
    }

    expect(await snapshot()).toEqual(before)
  })

  it.each(['client_admin', 'team_member'] as const)("%s cannot change another user's name", async (role) => {
    const before = await snapshot()
    const client = userClient(world.users[role].id)

    for (const target of [world.users.org_admin, world.outsider]) {
      const { data } = await client.from('users').update({ full_name: 'اسم مسروق' }).eq('id', target.id).select('id')
      expect(data ?? []).toEqual([])
    }

    expect(await snapshot()).toEqual(before)
  })

  it("an organization admin cannot change a user of another organization", async () => {
    const before = await snapshot()

    const { data } = await userClient(world.users.org_admin.id)
      .from('users')
      .update({ full_name: 'اسم مسروق' })
      .eq('id', world.outsider.id)
      .select('id')

    expect(data ?? []).toEqual([])
    expect(await snapshot()).toEqual(before)
  })
})
