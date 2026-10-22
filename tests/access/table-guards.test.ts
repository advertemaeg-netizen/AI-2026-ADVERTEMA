import { describe, expect, it } from 'vitest'
import { serviceClient } from '../harness/helpers'

/**
 * EVERY TABLE ANNOUNCES ITSELF (22 October 2026).
 *
 * The impersonation read-only guard was installed once, by a loop over the
 * tables that existed on its day, with a comment saying later tables need it
 * too. Three were added after it and none got it, so an impersonating super
 * admin could edit a client's branch hours. A comment is a note to a person
 * who was never going to read it; this is the version of that note that
 * works: a table added by any migration without the guard, or without row
 * level security, fails here the day it is added.
 *
 * Exceptions are named, each with its reason. Adding one is a decision, made
 * in this file where review sees it.
 */

/** Tables an impersonating super admin may write, and why */
const GUARD_EXCEPTIONS: Record<string, string> = {
  // The session itself: starting and ending one is what impersonating is
  impersonation_sessions: 'impersonation itself writes it',
}

type TableGuards = { table_name: string; has_client_id: boolean; rls_enabled: boolean; impersonation_guard: boolean }

async function tables(): Promise<TableGuards[]> {
  const { data, error } = await serviceClient().rpc('test_table_guards')
  if (error) throw new Error(error.message)
  return data as TableGuards[]
}

describe('every table of the public schema', () => {
  it('has row level security', async () => {
    const all = await tables()
    expect(all.length).toBeGreaterThan(20)
    expect(all.filter((t) => !t.rls_enabled).map((t) => t.table_name)).toEqual([])
  })

  it('is read-only to a super admin impersonating an organization, unless named as an exception', async () => {
    const unguarded = (await tables()).filter((t) => !t.impersonation_guard).map((t) => t.table_name)
    expect(unguarded).toEqual(Object.keys(GUARD_EXCEPTIONS).sort())
  })

  it('holds no client data among the exceptions', async () => {
    const exceptions = (await tables()).filter((t) => t.table_name in GUARD_EXCEPTIONS)
    expect(exceptions.filter((t) => t.has_client_id).map((t) => t.table_name)).toEqual([])
  })
})
