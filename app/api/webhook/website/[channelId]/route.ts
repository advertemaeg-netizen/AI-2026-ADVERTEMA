import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { geminiModel, type ChatTurn } from '@/lib/ai/gemini'
import { BOT_HISTORY_LIMIT, runBot } from '@/lib/ai/bot'
import { UUID_PATTERN } from '@/lib/types/clients'

// The widget is embedded on client websites, so any origin may call this route
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const MAX_MESSAGE_LENGTH = 2000
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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// GET: lets the widget check the channel exists and is live before rendering,
// and tells it where to subscribe for live agent replies (Realtime broadcast).
// With ?conversationId=&visitorId=[&after=] it returns agent replies the widget
// missed while disconnected.
export async function GET(request: NextRequest, ctx: RouteContext<'/api/webhook/website/[channelId]'>) {
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

  const params = request.nextUrl.searchParams
  const conversationId = params.get('conversationId')
  const visitorId = params.get('visitorId')
  if (conversationId || visitorId) {
    return agentReplies(supabase, channel.id, conversationId, visitorId, params.get('after'))
  }

  return json({
    ok: true,
    channel: { id: channel.id, name: channel.name },
    client: { name: channel.clients!.name },
    // The publishable key is already public; broadcast topics are scoped by
    // the visitor's random id, which only their browser knows
    realtime: {
      url: `${process.env.NEXT_PUBLIC_SUPABASE_URL!.replace(/^http/, 'ws')}/realtime/v1/websocket`,
      apiKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    },
  })
}

async function agentReplies(
  supabase: ReturnType<typeof createAdminClient>,
  channelId: string,
  conversationId: string | null,
  visitorId: string | null,
  after: string | null
) {
  if (
    !conversationId ||
    !UUID_PATTERN.test(conversationId) ||
    !visitorId ||
    !VISITOR_ID_PATTERN.test(visitorId) ||
    (after !== null && Number.isNaN(Date.parse(after)))
  ) {
    return json({ ok: false, error: 'invalid_request' }, 400)
  }

  try {
    // Same ownership check as POST: channel + visitor must both match
    const { data: conversation } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .eq('channel_id', channelId)
      .eq('contact_identifier', visitorId)
      .maybeSingle<{ id: string }>()
    if (!conversation) return json({ ok: false, error: 'not_found' }, 404)

    let query = supabase
      .from('messages')
      .select('id, content, created_at')
      .eq('conversation_id', conversation.id)
      .eq('role', 'agent')
      .order('created_at', { ascending: true })
      .limit(50)
    // `after` is passed back verbatim from a previous response so the
    // microsecond precision of created_at is preserved
    if (after) query = query.gt('created_at', after)

    const { data, error } = await query
    if (error) throw error
    return json({ ok: true, messages: data })
  } catch (error) {
    console.error('[webhook/website] GET replies', error)
    return json({ ok: false, error: 'server_error' }, 500)
  }
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

    // Resume the visitor's conversation only if it belongs to this channel and
    // visitor — otherwise a leaked id could be used to read someone else's chat
    let conversationId: string | null = null
    let autoReply = true
    if (requestedConversationId) {
      const { data: existing } = await supabase
        .from('conversations')
        .select('id, auto_reply_enabled')
        .eq('id', requestedConversationId)
        .eq('channel_id', channel.id)
        .eq('contact_identifier', visitorId)
        .maybeSingle<{ id: string; auto_reply_enabled: boolean }>()
      conversationId = existing?.id ?? null
      autoReply = existing?.auto_reply_enabled ?? true
    }

    // Usage limits only apply to AI replies; handed-off chats keep flowing
    let subscription: { id: string; messages_limit: number; messages_used: number; status: string } | null =
      null
    if (autoReply) {
      const { data } = await supabase
        .from('subscriptions')
        .select('id, messages_limit, messages_used, status')
        .eq('client_id', channel.client_id)
        .maybeSingle<{ id: string; messages_limit: number; messages_used: number; status: string }>()
      subscription = data

      if (
        subscription &&
        (subscription.status !== 'active' || subscription.messages_used >= subscription.messages_limit)
      ) {
        return json({ ok: false, error: 'limit_reached' }, 429)
      }
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

    // A human agent has taken over: store the message, skip the AI. The
    // agent's reply reaches the widget over Realtime broadcast.
    if (!autoReply) return json({ ok: true, conversationId, reply: null, handoff: true })

    const { data: recent, error: historyError } = await supabase
      .from('messages')
      .select('role, content')
      .eq('conversation_id', conversationId)
      .in('role', ['user', 'assistant', 'agent'])
      .order('created_at', { ascending: false })
      .limit(BOT_HISTORY_LIMIT)
      .returns<{ role: string; content: string }[]>()
    if (historyError) throw historyError

    const history: ChatTurn[] = recent
      .reverse()
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))

    let reply: string
    try {
      const result = await runBot({
        supabase,
        clientId: channel.client_id,
        client: channel.clients!,
        history,
      })
      reply = result.reply
    } catch (error) {
      console.error('[webhook/website] AI reply failed', error)
      return json({ ok: false, error: 'ai_unavailable', conversationId }, 502)
    }

    const { error: replyError } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: reply,
      metadata: { model: geminiModel() },
    })
    if (replyError) throw replyError

    // conversations.last_message_* is kept current by a trigger on messages

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
