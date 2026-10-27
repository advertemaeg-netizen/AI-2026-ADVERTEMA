import { describe, expect, it } from 'vitest'
import { seedClient, serviceClient } from '../harness/helpers'

/**
 * A paused channel is not a seat in use (20261106). The counter follows
 * is_active both ways, through the trigger, not only inserts and deletes.
 */
async function channelsUsed(clientId: string) {
  const { data, error } = await serviceClient().rpc('client_usage', { p_client_id: clientId })
  if (error) throw new Error(error.message)
  const row = (data as { limit_type: string; used: number }[]).find((u) => u.limit_type === 'channels')
  return Number(row?.used)
}

describe('the plan’s channel seats', () => {
  it('count active channels only, and follow a channel being paused and resumed', async () => {
    const { clientId, channelId } = await seedClient()
    const service = serviceClient()
    expect(await channelsUsed(clientId)).toBe(1)

    const { data: second } = await service
      .from('channels')
      .insert({ client_id: clientId, type: 'whatsapp', name: 'WhatsApp', external_id: `PN-${clientId}` })
      .select('id')
      .single<{ id: string }>()
    expect(await channelsUsed(clientId)).toBe(2)

    // The placeholder, paused: the seat is free again
    await service.from('channels').update({ is_active: false }).eq('id', second!.id)
    expect(await channelsUsed(clientId)).toBe(1)

    await service.from('channels').update({ is_active: true }).eq('id', second!.id)
    expect(await channelsUsed(clientId)).toBe(2)

    await service.from('channels').update({ is_active: false }).eq('id', channelId)
    expect(await channelsUsed(clientId)).toBe(1)
  })
})
