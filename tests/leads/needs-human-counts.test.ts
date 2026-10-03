import { describe, expect, it } from 'vitest'
import { createUser, seedClient, userClient } from '../harness/helpers'

/** Marks `count` new conversations on the seeded channel with `reason` */
async function mark(seeded: Awaited<ReturnType<typeof seedClient>>, reason: string | null, count: number) {
  const rows = Array.from({ length: count }, () => ({
    client_id: seeded.clientId,
    channel_id: seeded.channelId,
    needs_human_since: new Date().toISOString(),
    needs_human_reason: reason,
  }))
  const { error } = await seeded.supabase.from('conversations').insert(rows)
  if (error) throw new Error(error.message)
}

const byReason = (rows: { reason: string | null; conversations: number | string }[]) =>
  Object.fromEntries(rows.map(({ reason, conversations }) => [reason ?? 'null', Number(conversations)]))

describe('the needs-human banner counts', () => {
  it('counts every marked conversation per reason, past what a row fetch would return', async () => {
    const seeded = await seedClient()
    await mark(seeded, 'service_down', 1005)
    await mark(seeded, 'limit_reached', 2)
    await mark(seeded, null, 1)
    // Not marked: not counted
    await seeded.supabase.from('conversations').insert({ client_id: seeded.clientId, channel_id: seeded.channelId })

    const admin = await createUser('org_admin', seeded.organizationId, 'Org Admin')
    const { data, error } = await userClient(admin.id).rpc('needs_human_counts')

    expect(error).toBeNull()
    expect(byReason(data)).toEqual({ service_down: 1005, limit_reached: 2, null: 1 })
  })

  it("does not count another organization's conversations", async () => {
    const theirs = await seedClient()
    await mark(theirs, 'service_down', 3)
    const ours = await seedClient()

    const admin = await createUser('org_admin', ours.organizationId, 'Org Admin')
    const { data, error } = await userClient(admin.id).rpc('needs_human_counts')

    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
