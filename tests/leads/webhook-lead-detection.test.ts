import { describe, expect, it } from 'vitest'
import { geminiCalls, geminiError, geminiText, mockGemini, seedClient } from '../harness/helpers'
import { sendVisitorMessage } from './webhook'

const VISITOR_MESSAGE = 'السلام عليكم، أنا كريم مصطفى، عايز أحجز تنظيف أسنان. رقمي 01012345678'

const LEAD_ANALYSIS = JSON.stringify({
  is_lead: true,
  confidence: 0.95,
  name: 'كريم مصطفى',
  phone: '01012345678',
  service_requested: 'تنظيف أسنان',
  summary: 'العميل عايز يحجز تنظيف أسنان',
})

describe('website webhook: lead detection', () => {
  it('still analyses the visitor message and creates the lead when the reply fails with 503', async () => {
    const { supabase, clientId, channelId } = await seedClient()
    // The chat model is down; the analysis model answers
    mockGemini((call) => (call.kind === 'analysis' ? geminiText(LEAD_ANALYSIS) : geminiError(503)))

    const { status, body } = await sendVisitorMessage(channelId, VISITOR_MESSAGE)

    expect(status).toBe(502)
    expect(body).toMatchObject({ ok: false, error: 'ai_unavailable' })
    expect(geminiCalls.filter((call) => call.kind === 'reply')).toHaveLength(1)
    expect(geminiCalls.filter((call) => call.kind === 'analysis')).toHaveLength(1)

    const { data: leads } = await supabase
      .from('leads')
      .select('name, phone, status, conversation_id')
      .eq('client_id', clientId)
    expect(leads).toEqual([
      { name: 'كريم مصطفى', phone: '01012345678', status: 'new', conversation_id: body.conversationId },
    ])
  })

  it('never calls the model, for the reply or the analysis, when the subscription is inactive', async () => {
    const { supabase, clientId, channelId } = await seedClient()
    const { error } = await supabase.from('client_subscriptions').update({ status: 'cancelled' }).eq('client_id', clientId)
    expect(error).toBeNull()
    // Would create a lead if the analysis ran
    mockGemini((call) => geminiText(call.kind === 'analysis' ? LEAD_ANALYSIS : 'أهلاً بيك'))

    const { status, body } = await sendVisitorMessage(channelId, VISITOR_MESSAGE)

    // The visitor gets the client's fallback message instead of an AI reply
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(geminiCalls).toEqual([])

    const { data: leads } = await supabase.from('leads').select('id').eq('client_id', clientId)
    expect(leads).toEqual([])
    const { data: messages } = await supabase
      .from('messages')
      .select('role, metadata')
      .eq('conversation_id', body.conversationId)
      .order('created_at')
    expect(messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', metadata: { fallback: 'subscription_limit', reason: 'inactive' } },
    ])
  })
})
