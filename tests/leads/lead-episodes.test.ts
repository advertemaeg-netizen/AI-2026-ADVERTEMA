import { describe, expect, it } from 'vitest'
import { geminiCalls, geminiText, interceptRest, mockGemini, seedClient, uniqueViolation } from '../harness/helpers'
import { analyseTranscript, geminiWorks, newVisitorId, sendVisitorMessage, startConversation, INTRO_MESSAGE } from './webhook'

describe('a lead is one sales episode', () => {
  it('opens lead #2 when a customer who showed up comes back with a new request', async () => {
    mockGemini(geminiWorks)
    const conversation = await startConversation()
    const first = await conversation.attendFirstVisit()

    await conversation.send('أنا كريم مصطفى تاني، عايز أحجز تبييض المرة دي')

    const leads = await conversation.leads()
    expect(leads).toHaveLength(2)
    expect(leads[0]).toMatchObject({ id: first.id, status: 'showed_up' })
    expect(leads[1]).toMatchObject({ status: 'new', name: 'كريم مصطفى', service_requested: 'تبييض أسنان' })
  })

  it('opens no lead #2 when a customer who showed up only says thanks', async () => {
    mockGemini(geminiWorks)
    const conversation = await startConversation()
    const first = await conversation.attendFirstVisit()

    await conversation.send('شكراً جداً على الخدمة')

    // The message was analysed, on its own: the finished visit's request is not read again
    expect(geminiCalls.filter((call) => call.kind === 'analysis')).toHaveLength(2)
    expect(await conversation.leads()).toEqual([first])
  })

  it("leaves lead #1's appointment and attendance untouched when lead #2 is created", async () => {
    mockGemini(geminiWorks)
    const conversation = await startConversation()
    const first = await conversation.attendFirstVisit()
    expect(first).toMatchObject({ showed_up: true })
    expect(first.appointment_at).not.toBeNull()
    expect(first.arrival_confirmed_at).not.toBeNull()

    await conversation.send('عايز أحجز تاني بكرة الساعة 5')

    const [after, second] = await conversation.leads()
    expect(after).toEqual(first)
    expect(second).toMatchObject({ status: 'appointment_booked', showed_up: null })
    expect(second.appointment_at).not.toBeNull()
    expect(second.appointment_at).not.toBe(first.appointment_at)
  })

  // SKIPPED: not runnable on this harness. pglite-socket answers a failed
  // statement with a premature ReadyForQuery (electric-sql/pglite#958, open;
  // 0.2.11 is the latest release), so PostgREST drops the connection and the
  // losing inserts come back as PGRST001 instead of 23505. The race itself is
  // proven on the real stack: docs/diagnosis/repro-burst-new.log (10/10 runs,
  // one lead). The 23505 branch is covered by the next test, and the index by
  // one-open-lead-index.test.ts. Un-skip once the socket bug is fixed.
  it.skip('creates exactly one lead from 3 simultaneous messages on a new conversation', async () => {
    // Slow enough that all three analyses are in flight before any lead exists
    mockGemini(async (call) => {
      if (call.kind !== 'analysis') return geminiWorks(call)
      await new Promise((resolve) => setTimeout(resolve, 200))
      return geminiText(JSON.stringify(analyseTranscript(call)))
    })
    const { supabase, clientId, channelId } = await seedClient()
    const visitorId = newVisitorId()
    const { data: conversation } = await supabase
      .from('conversations')
      .insert({ client_id: clientId, channel_id: channelId, contact_identifier: visitorId, status: 'new' })
      .select('id')
      .single<{ id: string }>()
    const visitor = { visitorId, conversationId: conversation!.id }

    const responses = await Promise.all([
      sendVisitorMessage(channelId, INTRO_MESSAGE, visitor),
      sendVisitorMessage(channelId, 'عايز أحجز في أقرب وقت', visitor),
      sendVisitorMessage(channelId, 'ممكن حد يكلمني؟', visitor),
    ])

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200])
    expect(geminiCalls.filter((call) => call.kind === 'analysis')).toHaveLength(3)
    const { data: leads } = await supabase.from('leads').select('name, phone').eq('conversation_id', conversation!.id)
    expect(leads).toEqual([{ name: 'كريم مصطفى', phone: '01012345678' }])
  })

  it('enriches the lead a concurrent analysis opened first when its own insert hits 23505', async () => {
    mockGemini(geminiWorks)
    const { supabase, clientId, channelId } = await seedClient()
    // Another analysis of the same conversation wins the race: its lead (name
    // only) lands between this one's lookup and its insert, which is refused
    interceptRest({ path: '/leads', method: 'POST' }, async () => {
      const { data: conversation } = await supabase.from('conversations').select('id').eq('client_id', clientId).single<{ id: string }>()
      const winner = await supabase
        .from('leads')
        .insert({ client_id: clientId, conversation_id: conversation!.id, name: 'كريم مصطفى', status: 'new' })
      expect(winner.error).toBeNull()
      return uniqueViolation('one_open_lead_per_conversation')
    })

    const { body } = await sendVisitorMessage(channelId, INTRO_MESSAGE)

    // One lead: the winner's, now carrying what this analysis read
    const { data: leads } = await supabase
      .from('leads')
      .select('name, phone, service_requested, ai_extracted_data')
      .eq('conversation_id', body.conversationId)
    expect(leads).toHaveLength(1)
    expect(leads![0]).toMatchObject({
      name: 'كريم مصطفى',
      phone: '01012345678',
      service_requested: 'تنظيف أسنان',
      ai_extracted_data: { is_lead: true, phone: '01012345678' },
    })
  })

  it('opens lead #2 for a returning customer who gives no name or phone, inheriting them from lead #1', async () => {
    mockGemini(geminiWorks)
    const conversation = await startConversation()
    await conversation.attendFirstVisit()

    await conversation.send('عايز أحجز تاني')

    const leads = await conversation.leads()
    expect(leads).toHaveLength(2)
    expect(leads[1]).toMatchObject({ status: 'new', name: 'كريم مصطفى', phone: '01012345678' })
    // What the model itself read stays visible: it found neither
    expect(leads[1].ai_extracted_data).toMatchObject({ is_lead: true, name: null, phone: null })
  })

  it('stores what the model understood even when the message changes nothing on the lead', async () => {
    mockGemini(geminiWorks)
    const conversation = await startConversation()
    const [before] = await conversation.leads()
    expect(before.ai_extracted_data).toMatchObject({ is_lead: true, phone: '01012345678' })

    // The assistant's reply joins the transcript; nothing new for the lead itself
    mockGemini((call) =>
      call.kind === 'analysis'
        ? geminiText(JSON.stringify({ ...analyseTranscript(call), summary: 'العميل بيسأل عن المواعيد' }))
        : geminiWorks(call)
    )
    await conversation.send('انتوا فاتحين لحد امتى؟')

    const [after] = await conversation.leads()
    expect(after).toMatchObject({ name: before.name, phone: before.phone, status: before.status })
    expect(after.ai_extracted_data).toMatchObject({ summary: 'العميل بيسأل عن المواعيد' })
  })
})
