import { describe, expect, it } from 'vitest'
import { serviceClient, userClient, createUser } from '../harness/helpers'

/**
 * The deploy guard's function (20261105): the service role reads the list of
 * applied migration versions; nobody else can call it. The matrix test
 * records the refusal for every identity; this is the positive half, and the
 * shape the deploy script parses (a JSON array of version strings).
 */
describe('applied_migrations()', () => {
  it('answers the service role with the version list, as a JSON array of strings', async () => {
    const { data, error } = await serviceClient().rpc('applied_migrations')
    expect(error).toBeNull()
    // The test database is migrated by the harness, not the CLI, so its table is empty: the shape is what matters
    expect(Array.isArray(data)).toBe(true)
    for (const version of data as unknown[]) expect(typeof version).toBe('string')
  })

  it('is refused to a signed-in super admin', async () => {
    const admin = await createUser('super_admin', null, 'super')
    const { data, error } = await userClient(admin.id).rpc('applied_migrations')
    expect(error).not.toBeNull()
    expect(data).toBeNull()
  })
})
