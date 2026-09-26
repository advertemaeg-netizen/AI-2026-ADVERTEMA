import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateReply, geminiModel, type ChatTurn } from '@/lib/ai/gemini'
import { UUID_PATTERN } from '@/lib/types/clients'

// The widget is embedded on client websites, so any origin may call this route
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const MAX_MESSAGE_LENGTH = 2000
const HISTORY_LIMIT = 20
const VISITOR_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/

// Best-effort per-instance limiter. It resets on deploy and isn't shared
// between serverless instances — swap for a shared store before scaling.
const RATE_LIMIT = { windowMs: 60_000, max: 20 }
const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(key: string) {
  const now = Date.now()
  const entry = hits.get(key)
  if (!entry || entry.resetAt <= now) {
    if (hits.size > 10_000) hits.clear()
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT.max
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS_HEADERS })
}

type WebsiteChannel = {
  id: string
  client_id: string
  name: string
  is_active: boolean
  clients: {
    name: string
    industry: string | null
    description: string | null
    status: string
  } | null
}

async function loadChannel(supabase: ReturnType<typeof createAdminClient>, channelId: string) {
  if (!UUID_PATTERN.test(channelId)) return null

  const { data, error } = await supabase
    .from('channels')
    .select('id, client_id, name, is_active, clients(name, industry, description, status)')
    .eq('id', channelId)
    .eq('type', 'website')
    .maybeSingle<WebsiteChannel>()

  if (error) throw error
  return data
}

function isLive(channel: WebsiteChannel) {
  return channel.is_active && channel.clients?.status === 'active'
}

function buildSystemPrompt(client: NonNullable<WebsiteChannel['clients']>) {
  return [
    `You are the customer-service assistant for "${client.name}"${
      client.industry ? `, a business in the ${client.industry} sector` : ''
    }. You are chatting with a visitor through the chat widget on the business's website.`,
    client.description ? `About the business:\n${client.description}` : '',
    `Guidelines:
- Reply in the same language and dialect the visitor writes in (for example Egyptian Arabic, Modern Standard Arabic, or English).
- Be warm, helpful and concise: a few short sentences.
- Never invent prices, availability, addresses, offers or policies that are not stated above. If you don't know, say a team member will follow up.
- Try to understand which service the visitor needs, and politely ask for their name and phone number so the team can contact them.
- Write plain text only — no markdown, no code blocks.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// GET: lets the widget check the channel exists and is live before rendering
export async function GET(_request: NextRequest, ctx: RouteContext<'/api/webhook/website/[channelId]'>) {
  const { channelId } = await ctx.params
  const supabase = createAdminClient()

  let channel: WebsiteChannel | null
  try {
    channel = await loadChannel(supabase, channelId)
  } catch (error) {
    console.error('[webhook/website] GET', error)
    return json({ ok: false, error: 'server_error' }, 500)
  }

  if (!channel) return json({ ok: false, error: 'not_found' }, 404)
  if (!isLive(channel)) return json({ ok: false, error: 'inactive' }, 403)

  return json({
    ok: true,
    channel: { id: channel.id, name: channel.name },
    client: { name: channel.clients!.name },
  })
}

// POST: receives a visitor message, stores it, and returns the AI reply
export async function POST(request: NextRequest, ctx: RouteContext<'/api/webhook/website/[channelId]'>) {
  const { channelId } = await ctx.params

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
  if (rateLimited(`${ip}:${channelId}`)) {
    return json({ ok: false, error: 'rate_limited' }, 429)
  }

  let body: { message?: unknown; visitorId?: unknown; conversationId?: unknown; name?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400)
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const visitorId = typeof body.visitorId === 'string' ? body.visitorId : ''
  const requestedConversationId =
    typeof body.conversationId === 'string' && UUID_PATTERN.test(body.conversationId)
      ? body.conversationId
      : null
  const contactName =
    typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : null

  if (!message || message.length > MAX_MESSAGE_LENGTH || !VISITOR_ID_PATTERN.test(visitorId)) {
    return json({ ok: false, error: 'invalid_request' }, 400)
  }

  const supabase = createAdminClient()

  try {
    const channel = await loadChannel(supabase, channelId)
    if (!channel) return json({ ok: false, error: 'not_found' }, 404)
    if (!isLive(channel)) return json({ ok: false, error: 'inactive' }, 403)

    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('id, messages_limit, messages_used, status')
      .eq('client_id', channel.client_id)
      .maybeSingle<{ id: string; messages_limit: number; messages_used: number; status: string }>()

    if (
      subscription &&
      (subscription.status !== 'active' || subscription.messages_used >= subscription.messages_limit)
    ) {
      return json({ ok: false, error: 'limit_reached' }, 429)
    }

    // Resume the visitor's conversation only if it belongs to this channel and
    // visitor — otherwise a leaked id could be used to read someone else's chat
    let conversationId: string | null = null
    if (requestedConversationId) {
      const { data: existing } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', requestedConversationId)
        .eq('channel_id', channel.id)
        .eq('contact_identifier', visitorId)
        .maybeSingle<{ id: string }>()
      conversationId = existing?.id ?? null
    }

    if (!conversationId) {
      const { data: created, error } = await supabase
        .from('conversations')
        .insert({
          client_id: channel.client_id,
          channel_id: channel.id,
          contact_identifier: visitorId,
          contact_name: contactName,
          status: 'new',
        })
        .select('id')
        .single<{ id: string }>()
      if (error) throw error
      conversationId = created.id
    }

    const { error: userMessageError } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: message })
    if (userMessageError) throw userMessageError

    const { data: recent, error: historyError } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .in('role', ['user', 'assistant', 'agent'])
      .order('created_at', { ascending: false })
      .limit(HISTORY_LIMIT)
      .returns<{ role: string; content: string }[]>()
    if (historyError) throw historyError

    const history: ChatTurn[] = recent
      .reverse()
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))

    let reply: string
    try {
      reply = await generateReply({ systemPrompt: buildSystemPrompt(channel.clients!), history })
    } catch (error) {
      console.error('[webhook/website] AI reply failed', error)
      await supabase
        .from('conversations')
        .update({ last_message_at: new Date().toISOString() })
        .eq('id', conversationId)
      return json({ ok: false, error: 'ai_unavailable', conversationId }, 502)
    }

    const { error: replyError } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: reply,
      metadata: { model: geminiModel() },
    })
    if (replyError) throw replyError

    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversationId)

    if (subscription) {
      // Not atomic under concurrent requests; good enough for usage metering
      await supabase
        .from('subscriptions')
        .update({ messages_used: subscription.messages_used + 1 })
        .eq('id', subscription.id)
    }

    return json({ ok: true, conversationId, reply })
  } catch (error) {
    console.error('[webhook/website] POST', error)
    return json({ ok: false, error: 'server_error' }, 500)
  }
}
