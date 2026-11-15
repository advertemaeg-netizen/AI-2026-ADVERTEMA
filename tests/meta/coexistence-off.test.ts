import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectWhatsApp } from '@/lib/actions/whatsapp-connect'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, graphCalls, mockGemini, mockGraph, seedClient, serviceClient, type TestUser } from '../harness/helpers'
import { accountEvent, APP_SECRET, contactSync, deliver, historyChunk, historyDeclined, historyMedia, PERSON, phoneChange, phoneEcho, whatsappChannel } from './coexistence-payloads'

/**
 * WITH META_WHATSAPP_COEXISTENCE OFF, COEXISTENCE DOES NOTHING (2026-11-15).
 * The owner's condition: each of the four webhook fields a no-op in
 * production until the flag is on, provable by a test, not by inspection.
 * Every payload Meta documents for them is delivered, signed, through the
 * real route, to a channel already marked coexistence (the worst case), and
 * every table they could touch is counted before and after: nothing moves,
 * nothing is claimed, nothing is sent. The connect refuses a coexistence
 * signup too.
 */

const session = { user: null as TestUser | null }
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => {
    const { userClient, serviceClient: service } = await import('../harness/helpers')
    return { supabase: session.user ? userClient(session.user.id) : service(), profile: session.user, impersonation: null }
  },
  isImpersonating: async () => false,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const service = serviceClient()

beforeEach(() => {
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  vi.stubEnv('META_APP_ID', '1764087628157038')
  vi.stubEnv('META_WHATSAPP_CONFIG_ID', '1414870430631687')
  // Off as production has it: unset
  vi.stubEnv('META_WHATSAPP_COEXISTENCE', '')
  for (const level of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  mockGraph(() => Response.json({ error: { code: 100, message: 'no Graph call expected' } }, { status: 400 }))
  mockGemini(() => {
    throw new Error('no model call expected')
  })
})
afterEach(() => {
  session.user = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

/** Everything the four fields could write, for one channel */
async function footprint(channelId: string) {
  const count = async (table: string, column = 'channel_id') => {
    const { count, error } = await service.from(table).select('*', { count: 'exact', head: true }).eq(column, channelId)
    if (error) throw new Error(error.message)
    return count
  }
  const { data: conversations } = await service.from('conversations').select('id').eq('channel_id', channelId)
  const ids = (conversations ?? []).map((c) => c.id)
  const { count: messages } = ids.length ? await service.from('messages').select('*', { count: 'exact', head: true }).in('conversation_id', ids) : { count: 0 }
  const { data: channel } = await service
    .from('channels')
    .select('is_active, history_sync, history_sync_progress, history_imported, contacts_sync, coexistence_offboarded_at, connection_notice')
    .eq('id', channelId)
    .single()
  return {
    conversations: ids.length,
    messages,
    claims: await count('processed_meta_messages'),
    chunks: await count('whatsapp_history_chunks'),
    contacts: await count('whatsapp_contacts'),
    channel,
  }
}

describe('coexistence while META_WHATSAPP_COEXISTENCE is off', () => {
  it('each of the four webhook fields, as Meta documents it, writes nothing, claims nothing and sends nothing', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    const before = await footprint(channelId)

    for (const payload of [
      phoneEcho(wabaId, phoneNumberId, { id: 'wamid.ECHO.OFF.1' }),
      phoneEcho(wabaId, phoneNumberId, { id: 'wamid.ECHO.OFF.2', type: 'image' }),
      phoneChange(wabaId, phoneNumberId, { id: 'wamid.EDIT.OFF', original: 'wamid.ECHO.OFF.1', kind: 'edit' }),
      phoneChange(wabaId, phoneNumberId, { id: 'wamid.REVOKE.OFF', original: 'wamid.ECHO.OFF.1', kind: 'revoke' }),
      contactSync(wabaId, phoneNumberId, [{ action: 'add', phone: PERSON, name: 'سارة أحمد' }, { action: 'remove', phone: '201009999999' }]),
      historyChunk(wabaId, phoneNumberId, { progress: 40 }),
      historyChunk(wabaId, phoneNumberId, { progress: 100, chunk: 2 }),
      historyDeclined(wabaId, phoneNumberId),
      historyMedia(wabaId, phoneNumberId, 'wamid.H1'),
      accountEvent(wabaId, 'ACCOUNT_OFFBOARDED'),
    ]) {
      expect((await deliver(payload)).status).toBe(200)
    }

    expect(await footprint(channelId)).toEqual(before)
    expect(graphCalls).toHaveLength(0)
  })

  it('a coexistence signup is refused before anything is asked of Meta', async () => {
    const seeded = await seedClient()
    session.user = await createUser('org_admin', seeded.organizationId, 'مدير')
    const result = await connectWhatsApp(seeded.clientId, { code: 'AQD-code', wabaId: '980198427658004', phoneNumberId: null, coexistence: true })
    expect(result).toEqual({ ok: false, status: 'forbidden' })
    expect(graphCalls).toHaveLength(0)
    const { count } = await service.from('channels').select('*', { count: 'exact', head: true }).eq('client_id', seeded.clientId).eq('type', 'whatsapp')
    expect(count).toBe(0)
  })
})
