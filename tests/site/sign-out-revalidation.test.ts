import { beforeEach, describe, expect, it, vi } from 'vitest'
import { endImpersonation } from '@/lib/actions/impersonation'
import { IMPERSONATION_COOKIE } from '@/lib/auth/impersonation'
import { createUser, serviceClient, userClient, type TestUser } from '../harness/helpers'

/**
 * Every dashboard sign-out runs endImpersonation(). It used to revalidate
 * '/[locale]' at layout level each time, which invalidated every page of the
 * marketing site and 404'd it until the container was recreated (2026-10-19).
 * A sign-out with no account being viewed must revalidate nothing; ending a
 * real view refreshes the dashboard's and admin panel's shells only.
 */

const session = { user: null as TestUser | null }
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({
    supabase: session.user ? userClient(session.user.id) : serviceClient(),
    profile: session.user,
    impersonation: null,
  }),
}))

const jar = new Map<string, string>()
vi.mock('next/headers', () => ({
  cookies: async () => ({
    has: (name: string) => jar.has(name),
    delete: (name: string) => jar.delete(name),
    set: (name: string, value: string) => jar.set(name, value),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
  }),
}))

const revalidated: [string, string | undefined][] = []
vi.mock('next/cache', () => ({ revalidatePath: (path: string, type?: string) => revalidated.push([path, type]) }))

let user: TestUser

beforeEach(async () => {
  jar.clear()
  revalidated.length = 0
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`
  const { data, error } = await serviceClient().from('organizations').insert({ name: 'وكالة', slug, org_type: 'agency' }).select('id').single<{ id: string }>()
  if (error) throw new Error(error.message)
  user = await createUser('team_member', data.id, 'عضو الفريق')
  session.user = user
})

describe('signing out', () => {
  it('revalidates nothing when no account was being viewed', async () => {
    expect(await endImpersonation()).toEqual({ ok: true })
    expect(revalidated).toEqual([])
  })

  it('refreshes only the dashboard and admin shells when a view ends', async () => {
    jar.set(IMPERSONATION_COOKIE, 'a-session')
    expect(await endImpersonation()).toEqual({ ok: true })
    expect(jar.has(IMPERSONATION_COOKIE)).toBe(false)
    expect(revalidated).toEqual([
      ['/[locale]/dashboard', 'layout'],
      ['/[locale]/admin', 'layout'],
    ])
  })
})
