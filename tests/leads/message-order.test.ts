import { describe, expect, it } from 'vitest'
import { mockGemini, seedClient, serviceClient, userClient, createUser, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, lastVisitorMessage, newVisitorId, sendVisitorMessage } from './webhook'

/**
 * THE ORDERING DEFECT, CLOSED (2026-11-15; AGENTS.md, .scratch/coexistence-design.md Task 2).
 *
 * The bot answered whichever row sorted last by created_at, not the message
 * it was called for; and nothing stopped two runs on one conversation from
 * both answering. Run 28 (2026-11-12) caught the first: a visitor's message
 * stamped half a second before the reply to the message sent ahead of it,
 * and the bot answered that earlier message a second time.
 *
 *   - messages.seq numbers rows in the order they are written, under the
 *     conversation's lock; a client cannot set or change it;
 *   - the pipeline reads history up to the message it answers, by seq;
 *   - the reply is written only while nothing newer has arrived
 *     (insert_bot_reply): a newer visitor message gets its own answer, a
 *     person's reply means the bot says nothing.
 *
 * Every assertion here is on what was written and answered, never on a
 * timestamp's order: this harness's clock is not to be trusted with one.
 */

const service = serviceClient()

type Row = { id: string; role: string; content: string; seq: number }
const rows = async (conversationId: string) => {
  const { data, error } = await service.from('messages').select('id, role, content, seq').eq('conversation_id', conversationId).order('seq').returns<Row[]>()
  if (error) throw new Error(error.message)
  return data
}

/** A chat model that answers each visitor line with its own scripted reply, and can hold one line until released */
function scriptedModel(script: Record<string, string>, hold?: string) {
  const prompts: Record<string, string[]> = {}
  let release!: () => void
  let reached!: () => void
  const released = new Promise<void>((resolve) => (release = resolve))
  const holding = new Promise<void>((resolve) => (reached = resolve))
  mockGemini(async (call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(analyseTranscript(call)) }] } }] })
    const line = lastVisitorMessage(call)
    prompts[line] = (call.body.contents as { role: string; parts: { text: string }[] }[]).filter((t) => t.role === 'user').map((t) => t.parts[0].text)
    if (line === hold) {
      reached()
      await released
    }
    if (!(line in script)) throw new Error(`no scripted reply for "${line}"`)
    return botReply(script[line], null, null)
  })
  return { prompts, release, holding }
}

async function conversationWith(channelId: string) {
  const visitorId = newVisitorId()
  const first = await sendVisitorMessage(channelId, 'مرحبا', { visitorId })
  return { visitorId, conversationId: first.body.conversationId as string }
}

describe('messages.seq', () => {
  it('numbers rows in the order they are written, and no client can set or change it', async () => {
    const { clientId, channelId, organizationId } = await seedClient()
    const { data: conversation } = await service
      .from('conversations')
      .insert({ client_id: clientId, channel_id: channelId, contact_identifier: newVisitorId(), status: 'new' })
      .select('id')
      .single<{ id: string }>()
    const id = conversation!.id
    for (const content of ['one', 'two', 'three']) {
      // A seq sent with the insert is the trigger's to overwrite
      const { error } = await service.from('messages').insert({ conversation_id: id, role: 'user', content, seq: 1 })
      expect(error).toBeNull()
    }
    const written = await rows(id)
    expect(written.map((r) => r.content)).toEqual(['one', 'two', 'three'])
    expect(written[0].seq).toBeLessThan(written[1].seq)
    expect(written[1].seq).toBeLessThan(written[2].seq)

    // An update leaves it as it was, the service role's included
    await service.from('messages').update({ seq: 0, content: 'one, edited' }).eq('id', written[0].id)
    const after = await rows(id)
    expect(after[0]).toEqual({ ...written[0], content: 'one, edited' })

    // A person writing from the dashboard gets a number the same way
    const agent = await createUser('org_admin', organizationId, 'مدير')
    const { error: agentError } = await userClient(agent.id)
      .from('messages')
      .insert({ conversation_id: id, role: 'agent', content: 'four', sender_id: agent.id, seq: 1 })
    expect(agentError).toBeNull()
    const last = (await rows(id)).at(-1)!
    expect(last.content).toBe('four')
    expect(last.seq).toBeGreaterThan(written[2].seq)
  })
})

describe('insert_bot_reply', () => {
  async function thread() {
    const { clientId, channelId } = await seedClient()
    const { data } = await service
      .from('conversations')
      .insert({ client_id: clientId, channel_id: channelId, contact_identifier: newVisitorId(), status: 'new' })
      .select('id')
      .single<{ id: string }>()
    const id = data!.id
    const say = async (role: string, content: string, metadata: Record<string, unknown> | null = null) => {
      const { data: row, error } = await service.from('messages').insert({ conversation_id: id, role, content, metadata }).select('id').single<{ id: string }>()
      if (error) throw new Error(error.message)
      return row.id
    }
    const reply = async (answers: string) => {
      const { data: result, error } = await service.rpc('insert_bot_reply', { p_conversation_id: id, p_answers: answers, p_content: 'reply', p_metadata: { model: 'test' } })
      if (error) throw new Error(error.message)
      return (result as { id: string | null; withheld: string | null }[])[0]
    }
    return { id, say, reply }
  }

  it('writes the reply when nothing newer has arrived, after the bot’s own rows too', async () => {
    const { id, say, reply } = await thread()
    const question = await say('user', 'بكام التنظيف؟')
    await say('assistant', 'notice', { notice: 'unsupported' })
    const result = await reply(question)
    expect(result.withheld).toBeNull()
    expect((await rows(id)).at(-1)).toMatchObject({ id: result.id, role: 'assistant', content: 'reply' })
  })

  it('withholds it for a newer message from the visitor, which gets its own answer', async () => {
    const { id, say, reply } = await thread()
    const first = await say('user', 'بكام التنظيف؟')
    await say('user', 'وبكام التبييض؟')
    expect(await reply(first)).toEqual({ id: null, withheld: 'visitor' })
    expect((await rows(id)).filter((r) => r.role === 'assistant')).toEqual([])
  })

  it('withholds it for a person’s reply, from the dashboard or a Page inbox', async () => {
    const { say, reply } = await thread()
    const question = await say('user', 'بكام التنظيف؟')
    await say('agent', 'أهلاً، التنظيف بـ 500', { transport: 'messenger', echo: true, messageId: 'm_1' })
    expect(await reply(question)).toEqual({ id: null, withheld: 'person' })
  })

  it('is not withheld by a reaction or a placeholder: nothing answers those', async () => {
    const { say, reply } = await thread()
    const question = await say('user', 'بكام التنظيف؟')
    await say('user', '[تفاعل]', { whatsapp_type: 'reaction', reaction: { emoji: '👍' } })
    await say('user', '[رسالة صوتية]', { whatsapp_type: 'audio', placeholder: true })
    expect((await reply(question)).withheld).toBeNull()
  })

  it('writes nothing for a message of another conversation', async () => {
    const other = await thread()
    const elsewhere = await other.say('user', 'hello')
    const { id, reply } = await thread()
    expect(await reply(elsewhere)).toEqual({ id: null, withheld: 'not_found' })
    expect(await rows(id)).toEqual([])
  })
})

describe('the pipeline answers the message it was called for', () => {
  it('whatever created_at says: run 28’s inversion, reproduced, is answered right', async () => {
    const { channelId } = await seedClient()
    scriptedModel({ مرحبا: 'أهلاً', 'ايه المواعيد المتاحه': 'من 1 لـ 10', 'الخميس الساعة 11': 'تمام، الخميس 11' })
    const { visitorId, conversationId } = await conversationWith(channelId)
    await sendVisitorMessage(channelId, 'ايه المواعيد المتاحه', { visitorId, conversationId })

    // Run 28: the message sent before stamped after. Set its created_at an hour ahead
    const earlier = (await rows(conversationId)).find((r) => r.content === 'ايه المواعيد المتاحه')!
    await service.from('messages').update({ created_at: new Date(Date.now() + 3_600_000).toISOString() }).eq('id', earlier.id)

    const { body } = await sendVisitorMessage(channelId, 'الخميس الساعة 11', { visitorId, conversationId })
    expect(body.reply).toBe('تمام، الخميس 11')
    expect((await rows(conversationId)).map((r) => [r.role, r.content])).toEqual([
      ['user', 'مرحبا'],
      ['assistant', 'أهلاً'],
      ['user', 'ايه المواعيد المتاحه'],
      ['assistant', 'من 1 لـ 10'],
      ['user', 'الخميس الساعة 11'],
      ['assistant', 'تمام، الخميس 11'],
    ])
  })

  it('two messages at once: the first is withheld, the second is answered, having read both', async () => {
    const { channelId } = await seedClient()
    const model = scriptedModel({ مرحبا: 'أهلاً', 'بكام التنظيف؟': 'first answer', 'وبكام التبييض؟': 'both answered' }, 'بكام التنظيف؟')
    const { visitorId, conversationId } = await conversationWith(channelId)

    const first = sendVisitorMessage(channelId, 'بكام التنظيف؟', { visitorId, conversationId })
    await model.holding
    // The second arrives while the first is with the model
    const second = await sendVisitorMessage(channelId, 'وبكام التبييض؟', { visitorId, conversationId })
    model.release()
    const firstAnswer = await first

    expect(second.body).toMatchObject({ ok: true, reply: 'both answered' })
    expect(firstAnswer.body).toMatchObject({ ok: true, reply: null, withheld: true })
    // The second's run read the first: both questions were in its prompt
    expect(model.prompts['وبكام التبييض؟']).toEqual(['مرحبا', 'بكام التنظيف؟', 'وبكام التبييض؟'])
    // The first's run read only what came before it
    expect(model.prompts['بكام التنظيف؟']).toEqual(['مرحبا', 'بكام التنظيف؟'])
    expect((await rows(conversationId)).map((r) => [r.role, r.content])).toEqual([
      ['user', 'مرحبا'],
      ['assistant', 'أهلاً'],
      ['user', 'بكام التنظيف؟'],
      ['user', 'وبكام التبييض؟'],
      ['assistant', 'both answered'],
    ])
  })

  it('a person replying while the bot is thinking: the bot sends nothing over them', async () => {
    const { channelId, organizationId } = await seedClient()
    const model = scriptedModel({ مرحبا: 'أهلاً', 'بكام التنظيف؟': 'the bot’s answer' }, 'بكام التنظيف؟')
    const { visitorId, conversationId } = await conversationWith(channelId)

    const pending = sendVisitorMessage(channelId, 'بكام التنظيف؟', { visitorId, conversationId })
    await model.holding
    const agent = await createUser('org_admin', organizationId, 'مدير')
    const { error } = await userClient(agent.id).from('messages').insert({ conversation_id: conversationId, role: 'agent', content: 'التنظيف بـ 500', sender_id: agent.id })
    expect(error).toBeNull()
    model.release()

    expect((await pending).body).toMatchObject({ ok: true, reply: null, withheld: true })
    expect((await rows(conversationId)).map((r) => [r.role, r.content])).toEqual([
      ['user', 'مرحبا'],
      ['assistant', 'أهلاً'],
      ['user', 'بكام التنظيف؟'],
      ['agent', 'التنظيف بـ 500'],
    ])
  })
})
