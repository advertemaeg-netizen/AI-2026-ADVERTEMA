import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTemplateAction, getTemplates } from '@/lib/actions/templates'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, graphCalls, mockGraph, seedClient, serviceClient, type GraphCall, type TestUser } from '../harness/helpers'

/**
 * THE WHATSAPP TEMPLATES SCREEN.
 *   - the list is read live from Meta, with the channel's token, and Meta's
 *     statuses fold to approved / pending / rejected / unavailable;
 *   - a failed read throws (the error screen), never an empty list;
 *   - a template is created as UTILITY with one BODY: there is no category
 *     anywhere in the input;
 *   - the same name in the same language is refused before Meta is asked;
 *   - a name that breaks Meta's rule, or a body with a variable, never
 *     reaches Meta;
 *   - another organization's admin reads nothing and creates nothing;
 *   - the token and the template's text are never in the log.
 */

const TOKEN = 'EAAG-templates-token-never-logged'
const WABA = '300400500600700'
const SECRET_BODY = 'نص سري لا يظهر في السجل'

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

let output: () => string
beforeEach(() => {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  output = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
})
afterEach(() => {
  session.user = null
  vi.restoreAllMocks()
})

async function clinicWithWhatsApp() {
  const seeded = await seedClient()
  const service = serviceClient()
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type: 'whatsapp', name: 'WhatsApp', external_id: `PN-${crypto.randomUUID()}` })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN, waba_id: WABA })
  if (secretError) throw secretError
  session.user = await createUser('org_admin', seeded.organizationId, 'مدير')
  return { ...seeded, whatsappId: channel.id }
}

const isList = (call: GraphCall) => call.method === 'GET' && call.url.includes(`/${WABA}/message_templates`)
const isCreate = (call: GraphCall) => call.method === 'POST' && call.url === `https://graph.facebook.com/v25.0/${WABA}/message_templates`

const template = (name: string, language: string, status: string, text = 'نذكّرك بميعادك بكرة') => ({
  id: `T-${name}-${language}`,
  name,
  language,
  status,
  category: 'UTILITY',
  components: [{ type: 'BODY', text }],
})

const EXISTING = [
  template('appointment_reminder', 'ar', 'APPROVED'),
  template('waiting', 'ar', 'PENDING'),
  template('appeal', 'en', 'IN_APPEAL'),
  template('promo', 'ar', 'REJECTED'),
  template('paused_one', 'ar', 'PAUSED'),
  template('gone', 'en_US', 'DISABLED'),
]

function meta({ list = EXISTING, create = () => Response.json({ id: 'NEW-1', status: 'PENDING', category: 'UTILITY' }) }: { list?: unknown[] | Response; create?: () => Response } = {}) {
  mockGraph((call) => {
    if (isList(call)) return list instanceof Response ? list : Response.json({ data: list, paging: { cursors: { before: 'a', after: 'b' } } })
    if (isCreate(call)) return create()
    throw new Error(`unexpected Graph call ${call.method} ${call.url}`)
  })
}

describe('the templates list', () => {
  it('is read live from Meta with the channel’s token, and Meta’s statuses fold to four', async () => {
    const { clientId, whatsappId } = await clinicWithWhatsApp()
    meta()
    const lists = await getTemplates(clientId)

    expect(lists).toHaveLength(1)
    expect(lists[0].channelId).toBe(whatsappId)
    expect(lists[0].templates.map((t) => [t.name, t.language, t.status])).toEqual([
      ['appointment_reminder', 'ar', 'approved'],
      ['waiting', 'ar', 'pending'],
      ['appeal', 'en', 'pending'],
      ['promo', 'ar', 'rejected'],
      ['paused_one', 'ar', 'unavailable'],
      ['gone', 'en_US', 'unavailable'],
    ])
    expect(lists[0].templates[0].body).toBe('نذكّرك بميعادك بكرة')
    const reads = graphCalls.filter(isList)
    expect(reads).toHaveLength(1)
    expect(reads[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(reads[0].url).not.toContain(TOKEN)
    expect(output()).not.toContain(TOKEN)
  })

  it('follows Meta’s pages while there is a next one', async () => {
    const { clientId } = await clinicWithWhatsApp()
    mockGraph((call) => {
      if (!isList(call)) throw new Error(`unexpected Graph call ${call.url}`)
      const second = new URL(call.url).searchParams.get('after') === 'CURSOR-2'
      return second
        ? Response.json({ data: [template('two', 'ar', 'APPROVED')], paging: { cursors: { after: 'END' } } })
        : Response.json({ data: [template('one', 'ar', 'APPROVED')], paging: { cursors: { after: 'CURSOR-2' }, next: 'https://graph.facebook.com/next' } })
    })
    const [list] = await getTemplates(clientId)
    expect(list.templates.map((t) => t.name)).toEqual(['one', 'two'])
    expect(graphCalls.filter(isList)).toHaveLength(2)
  })

  it('throws when Meta refuses the read: an empty list would say "no templates", which is false', async () => {
    const { clientId } = await clinicWithWhatsApp()
    meta({ list: Response.json({ error: { code: 190, message: 'token expired' } }, { status: 401 }) })
    await expect(getTemplates(clientId)).rejects.toThrow(/status 401, code 190/)
  })

  it('is empty for a client with no WhatsApp channel, and asks Meta nothing', async () => {
    const seeded = await seedClient()
    session.user = await createUser('org_admin', seeded.organizationId, 'مدير')
    meta()
    expect(await getTemplates(seeded.clientId)).toEqual([])
    expect(graphCalls.filter(isList)).toHaveLength(0)
  })

  it('shows another organization’s admin nothing, and asks Meta nothing', async () => {
    const { clientId } = await clinicWithWhatsApp()
    const stranger = await seedClient()
    session.user = await createUser('org_admin', stranger.organizationId, 'غريب')
    meta()
    expect(await getTemplates(clientId)).toEqual([])
    expect(graphCalls.filter(isList)).toHaveLength(0)
  })
})

describe('creating a template', () => {
  it('submits it as UTILITY with one BODY, in the chosen language, and says it is pending', async () => {
    const { clientId, whatsappId } = await clinicWithWhatsApp()
    meta()
    const result = await createTemplateAction(clientId, whatsappId, { name: 'visit_followup', language: 'ar', body: SECRET_BODY })

    expect(result).toEqual({ ok: true, status: 'pending' })
    const creates = graphCalls.filter(isCreate)
    expect(creates).toHaveLength(1)
    expect(creates[0].body).toEqual({ name: 'visit_followup', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: SECRET_BODY }] })
    expect(creates[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(output()).not.toContain(TOKEN)
    expect(output()).not.toContain(SECRET_BODY)
  })

  it('ignores a category sent by the browser: UTILITY is fixed in the code', async () => {
    const { clientId, whatsappId } = await clinicWithWhatsApp()
    meta()
    await createTemplateAction(clientId, whatsappId, { name: 'sneaky', language: 'en', body: 'Hello', category: 'MARKETING' })
    expect(graphCalls.filter(isCreate)[0].body.category).toBe('UTILITY')
  })

  it('refuses the same name in the same language before asking Meta; another language is allowed', async () => {
    const { clientId, whatsappId } = await clinicWithWhatsApp()
    meta()
    expect(await createTemplateAction(clientId, whatsappId, { name: 'appointment_reminder', language: 'ar', body: 'نص' })).toEqual({ ok: false, error: 'nameTaken' })
    expect(graphCalls.filter(isCreate)).toHaveLength(0)

    expect(await createTemplateAction(clientId, whatsappId, { name: 'appointment_reminder', language: 'en', body: 'Text' })).toEqual({ ok: true, status: 'pending' })
    expect(graphCalls.filter(isCreate)).toHaveLength(1)
  })

  it.each([
    ['an Arabic name', { name: 'تذكير', language: 'ar', body: 'نص' }],
    ['capitals', { name: 'Reminder', language: 'ar', body: 'نص' }],
    ['a space', { name: 'my reminder', language: 'ar', body: 'نص' }],
    ['a variable in the body', { name: 'reminder', language: 'ar', body: 'ميعادك {{1}}' }],
    ['an empty body', { name: 'reminder', language: 'ar', body: '   ' }],
    ['a body past 1024 characters', { name: 'reminder', language: 'ar', body: 'ا'.repeat(1025) }],
    ['a language we do not offer', { name: 'reminder', language: 'fr', body: 'Bonjour' }],
  ])('never sends a template with %s to Meta', async (_, input) => {
    const { clientId, whatsappId } = await clinicWithWhatsApp()
    meta()
    expect(await createTemplateAction(clientId, whatsappId, input)).toEqual({ ok: false, error: 'validation' })
    expect(graphCalls).toHaveLength(0)
  })

  it('says it failed when Meta refuses, logging the codes and nothing of the text', async () => {
    const { clientId, whatsappId } = await clinicWithWhatsApp()
    meta({ create: () => Response.json({ error: { code: 100, error_subcode: 2388299, message: SECRET_BODY } }, { status: 400 }) })
    expect(await createTemplateAction(clientId, whatsappId, { name: 'refused_one', language: 'ar', body: SECRET_BODY })).toEqual({ ok: false, error: 'createFailed' })
    expect(output()).toContain('2388299')
    expect(output()).not.toContain(SECRET_BODY)
    expect(output()).not.toContain(TOKEN)
  })

  it('refuses another organization’s admin, and a channel that is not this client’s WhatsApp', async () => {
    const { clientId, whatsappId, channelId: websiteId } = await clinicWithWhatsApp()
    meta()
    expect(await createTemplateAction(clientId, websiteId, { name: 'web', language: 'ar', body: 'نص' })).toEqual({ ok: false, error: 'forbidden' })

    const stranger = await seedClient()
    session.user = await createUser('org_admin', stranger.organizationId, 'غريب')
    expect(await createTemplateAction(clientId, whatsappId, { name: 'stolen', language: 'ar', body: 'نص' })).toEqual({ ok: false, error: 'forbidden' })
    expect(graphCalls).toHaveLength(0)
  })
})
