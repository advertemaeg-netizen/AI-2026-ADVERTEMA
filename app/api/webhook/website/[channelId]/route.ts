import { after, NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { aiFailureReason, replyModel, type ChatTurn } from '@/lib/ai/provider'
import { BOT_HISTORY_LIMIT, loadBotSettings, runBot } from '@/lib/ai/bot'
import { detectLead } from '@/lib/ai/lead-detection'
import {
  APPOINTMENT_PLACEHOLDER,
  ASK_DAY_AND_TIME,
  NOTHING_SAID,
  mergeDraft,
  narrowDraft,
  parseBookingDraft,
  replyLanguage,
  resolvesWhole,
  saysNothing,
  withoutTime,
  type AppointmentRequest,
  type BookingDraft,
  type BookingOutcome,
  type ReplyRules,
} from '@/lib/ai/appointment'
import { withEvidence, type EvidencedPart } from '@/lib/ai/evidence'
import { appointmentOnRecord, bookingState, confirmPending, recordAppointment, saveContact, savedRecord } from '@/lib/ai/booking'
import { composeReply, mentionsName, type SavedRecord } from '@/lib/ai/compose'
import {
  EMPTY_CONTACT,
  MAX_PHONE_REJECTIONS,
  parseContactState,
  readContact,
  type ContactEvents,
  type ContactState,
} from '@/lib/ai/contact'
import { effectiveBookingMode, type BotSettingsInput } from '@/lib/types/bot-settings'
import ar from '../../../../../messages/ar.json'
import en from '../../../../../messages/en.json'
import { checkClientLimit } from '@/lib/subscription-limits'
import { UUID_PATTERN } from '@/lib/types/clients'
import type { NeedsHumanReason } from '@/lib/types/conversations'

// The widget is embedded on client websites, so any origin may call this route
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
}

const BOOKING_TEXTS = { ar: ar.botReplies.appointment, en: en.botReplies.appointment }

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
    organizations: { is_active: boolean } | null
  } | null
}

async function loadChannel(supabase: ReturnType<typeof createAdminClient>, channelId: string) {
  if (!UUID_PATTERN.test(channelId)) return null

  const { data, error } = await supabase
    .from('channels')
    .select('id, client_id, name, is_active, clients(name, industry, description, status, organizations(is_active))')
    .eq('id', channelId)
    .eq('type', 'website')
    .maybeSingle<WebsiteChannel>()

  if (error) throw error
  return data
}

// A disabled organization's bots stop too (super admin panel)
function isLive(channel: WebsiteChannel) {
  return (
    channel.is_active &&
    channel.clients?.status === 'active' &&
    channel.clients.organizations?.is_active === true
  )
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

  // The widget opens with the client's configured welcome message
  let welcomeMessage: string | null = null
  try {
    welcomeMessage = (await loadBotSettings(supabase, channel.client_id)).welcome_message
  } catch (error) {
    console.error('[webhook/website] loading bot settings failed', error)
  }

  return json({
    ok: true,
    channel: { id: channel.id, name: channel.name },
    client: { name: channel.clients!.name },
    welcomeMessage,
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

    const { data: userMessage, error: userMessageError } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: message })
      .select('id')
      .single<{ id: string }>()
    if (userMessageError) throw userMessageError

    const { data: recent, error: historyError } = await supabase
      .from('messages')
      .select('role, content, metadata')
      .eq('conversation_id', conversationId)
      .in('role', ['user', 'assistant', 'agent'])
      .order('created_at', { ascending: false })
      .limit(BOT_HISTORY_LIMIT)
      .returns<{ role: string; content: string; metadata: { contact?: unknown; booking?: unknown; draft?: unknown } | null }[]>()
    if (historyError) throw historyError

    // Newest first here: the name and number as the latest reply left them
    const previousContact =
      recent.map((m) => (m.role === 'assistant' ? parseContactState(m.metadata?.contact) : null)).find(Boolean) ?? EMPTY_CONTACT
    // The partial booking as the latest bot reply left it (one with a booking
    // trace: a fallback message says nothing about it). No draft on that reply
    // means there was none: an older one ended there. The lead row's own
    // draft, read below, takes precedence: this is for conversations that
    // were under way before the row held it.
    const lastReplyTrace = recent.find((m) => m.role === 'assistant' && m.metadata?.booking !== undefined)?.metadata
    const tracedDraft = parseBookingDraft(lastReplyTrace?.draft)
    const history: ChatTurn[] = recent
      .reverse()
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
    const visitorMessages = recent.filter((m) => m.role === 'user').map((m) => m.content)

    let settings: BotSettingsInput | null = null
    try {
      settings = await loadBotSettings(supabase, channel.client_id)
    } catch (error) {
      console.error('[webhook/website] loading bot settings failed', error)
    }

    // Lead detection runs after the response is sent, so it never slows the
    // reply. It runs whatever happens to the reply: detectLead itself decides
    // whether the client's subscription allows the analysis.
    const convId = conversationId
    const scheduleLeadDetection = (turns: ChatTurn[], replied = false, contact: ContactState | null = null) => {
      // Always: a lead's name and number never depend on a switch
      after(() =>
        detectLead({
          supabase,
          clientId: channel.client_id,
          conversationId: convId,
          sourceMessageId: userMessage.id,
          history: turns,
          replied,
          businessHours: settings?.business_hours ?? null,
          contact,
        })
      )
    }

    // A human agent has taken over: store the message, skip the AI. The
    // agent's reply reaches the widget over Realtime broadcast. Visitors often
    // share their details at this point, so still look for a lead.
    if (!autoReply) {
      scheduleLeadDetection(history)
      return json({ ok: true, conversationId, reply: null, handoff: true })
    }

    if (!settings) {
      scheduleLeadDetection(history)
      return json({ ok: false, error: 'ai_unavailable', conversationId }, 502)
    }

    // The visitor got no real answer: the conversation waits for a person,
    // with the cause, from the first message that happened to. Never fails
    // the request: the visitor has their message either way.
    const markForPerson = async (reason: NeedsHumanReason) => {
      const { error } = await supabase
        .from('conversations')
        .update({ needs_human_since: new Date().toISOString(), needs_human_reason: reason })
        .eq('id', convId)
        .is('needs_human_since', null)
      if (error) console.error('[webhook/website] marking the conversation for a person failed', error)
    }

    // Usage limits only apply to AI replies (handed-off chats keep flowing).
    // Past the client plan's monthly messages, or without an active
    // subscription (the client's or its agency's), visitors are told the
    // assistant can't answer right now, and the team why.
    let quota: Awaited<ReturnType<typeof checkClientLimit>>
    try {
      quota = await checkClientLimit(supabase, channel.client_id, 'messages')
    } catch (error) {
      // No reply without a known quota, but the message is still analysed
      console.error('[webhook/website] limit check failed', error)
      scheduleLeadDetection(history)
      return json({ ok: false, error: 'ai_unavailable', conversationId }, 502)
    }
    if (quota && !quota.allowed) {
      const { error: fallbackError } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: settings.service_unavailable_message,
        metadata: { fallback: 'subscription_limit', reason: quota.reason },
      })
      if (fallbackError) throw fallbackError
      await markForPerson(quota.reason === 'inactive' ? 'inactive' : 'limit_reached')
      // Past the limit, leads are still captured up to the ceiling
      scheduleLeadDetection([...history, { role: 'assistant', content: settings.service_unavailable_message }])
      return json({ ok: true, conversationId, reply: settings.service_unavailable_message, fallback: true })
    }

    let reply: string
    // Stored with the reply: what the model answered, and what became of the
    // appointment it reported
    let trace: {
      raw: string
      booking: BookingOutcome['status']
      booking_error?: true
      evidence_dropped?: EvidencedPart[]
      /** What the visitor has said toward an appointment that is not one yet; the next message starts from here */
      draft: BookingDraft | null
      /** The name and number as code holds them after this message; the next message starts from here */
      contact?: ContactState
      contact_events?: ContactEvents
    }
    let contact: ContactState | null = null
    // The business's booking shape, and how much of a name it asks for
    const mode = effectiveBookingMode(settings)
    const rules: ReplyRules = { mode, nameStrictness: settings.name_strictness }

    // The open lead as it stands: a day (and time) held for the visitor's
    // details, and the partial booking written so far. Unread, the message
    // trace stands in: it never blocks a reply.
    let held = false
    let previousDraft = tracedDraft
    try {
      const state = await bookingState(supabase, conversationId)
      held = state.held
      if (state.hasDraft) previousDraft = state.draft
    } catch (error) {
      console.error('[webhook/website] reading the open lead failed', error)
    }
    // A partial booking that is already whole: written before a booking that
    // failed (5.2). It is booked on this message, whatever it is about, and the
    // visitor is not asked again for what they gave.
    const resumable =
      mode !== 'none' && previousDraft !== null && resolvesWhole(previousDraft, mode, settings.business_hours)

    // THE PHONE IS CODE'S TO READ, so it is read and written before the model
    // is called: a reply that fails cannot lose a number the visitor sent. (The
    // name needs the model's report; it is read after.) After the plan's limits
    // above, as every capture is: a person's takeover and a plan past its
    // limit are left to the analysis, as before.
    const early = readContact(previousContact, null, message, visitorMessages, settings.name_strictness)
    if (early.events.phone === 'stored') {
      try {
        await saveContact({
          supabase,
          clientId: channel.client_id,
          conversationId,
          sourceMessageId: userMessage.id,
          contact: { ...previousContact, phone: early.state.phone },
          events: { name: 'none', phone: 'stored' },
        })
      } catch (error) {
        console.error('[webhook/website] saving the phone number failed', error)
      }
    }

    try {
      // A day or time held from earlier may become the appointment on this
      // message without the model reporting one: it is told so before it answers
      held = mode !== 'none' && (held || resumable)
      const result = await runBot({
        supabase,
        clientId: channel.client_id,
        client: channel.clients!,
        settings,
        history,
        operation: 'chat_reply',
        conversationId,
        knownContact: previousContact,
        heldRequest: held,
      })

      // The model reported; code decides. The name and the number are
      // checked and written before the reply is rendered, so the reply can
      // only state what the lead row holds. Always: the name and the number
      // are the product, and no setting turns them off.
      const read = readContact(previousContact, result.contact, message, visitorMessages, settings.name_strictness)
      contact = read.state
      const events: ContactEvents = read.events
      let booking: BookingOutcome = { status: 'none' }
      let bookingFailed = false
      // Kept as it was unless this message reported something about the appointment
      let draft = previousDraft
      // What the model reported that the message gave no trace of
      let evidenceDropped: EvidencedPart[] = []
      // Code decided something about the appointment on this message: then
      // code alone speaks about it (composeReply)
      let decided = result.appointment !== null

      // Only what this message shows a trace of (withEvidence), completed with
      // what earlier ones gave (the draft). A day-only business takes no time,
      // whatever the model reported.
      let request: AppointmentRequest | null = null
      if (result.appointment) {
        const evidenced = withEvidence(result.appointment, message)
        evidenceDropped = evidenced.dropped
        const merged = mergeDraft(previousDraft, evidenced.request)
        request = mode === 'day_only' ? withoutTime(merged) : merged
      }
      // THE LEAD AS IT ARRIVES: the name, the number, and the partial booking
      // with what this message added, written now — before anything is booked,
      // so nothing given can be lost to a failure further on
      const arriving = request && !saysNothing(request) ? narrowDraft(previousDraft, request, ASK_DAY_AND_TIME) : undefined
      try {
        await saveContact({
          supabase,
          clientId: channel.client_id,
          conversationId,
          sourceMessageId: userMessage.id,
          contact,
          events,
          ...(arriving !== undefined ? { draft: arriving } : {}),
        })
      } catch (error) {
        // Not saved: the reply states the record, so it will say so
        console.error('[webhook/website] saving the lead failed', error)
      }

      // The appointment is recorded before the reply goes out, and the reply
      // quotes the record: it can't promise a time that isn't stored
      if (request) {
        try {
          if (saysNothing(request)) {
            // Reported, but none of it was said and nothing is held: as if
            // nothing was reported. The model's reply was written for the
            // appointment it reported, so code still speaks: a held time is
            // booked once it can be, one on record is restated, and otherwise
            // the visitor is asked for the day and time.
            booking =
              (await confirmPending({ supabase, conversationId, businessHours: settings.business_hours, contact })) ??
              (await appointmentOnRecord({ supabase, conversationId }))
            if (booking.status === 'none') booking = ASK_DAY_AND_TIME
          } else {
            booking = await recordAppointment({
              supabase,
              clientId: channel.client_id,
              conversationId,
              sourceMessageId: userMessage.id,
              request,
              autoConfirm: settings.auto_confirm_appointments,
              businessHours: settings.business_hours,
              source: 'reply',
              contact,
              // The visitor is here to be asked the hour rather than given a guess at one
              hourFromPartOfDay: false,
              mode: mode === 'day_only' ? 'day_only' : 'appointment',
            })
          }
          draft = narrowDraft(previousDraft, request, booking)
        } catch (error) {
          console.error('[webhook/website] recording the appointment failed', error)
          bookingFailed = true
          // As written above: what the visitor gave stays, for the next message to book
          draft = arriving ?? previousDraft
        }
      } else if (mode !== 'none') {
        // A time asked for earlier, held back for a name or a number: once
        // both are on record it becomes the appointment, whatever this
        // message is about; until then code asks for the next one. A partial
        // booking already whole (a booking write that failed) is booked the
        // same way.
        try {
          const promoted = await confirmPending({ supabase, conversationId, businessHours: settings.business_hours, contact })
          if (promoted) {
            booking = promoted
            decided = true
            draft = null
          } else if (resumable && previousDraft) {
            const resumed = mergeDraft(previousDraft, NOTHING_SAID)
            booking = await recordAppointment({
              supabase,
              clientId: channel.client_id,
              conversationId,
              sourceMessageId: userMessage.id,
              request: resumed,
              autoConfirm: settings.auto_confirm_appointments,
              businessHours: settings.business_hours,
              source: 'reply',
              contact,
              hourFromPartOfDay: false,
              mode: mode === 'day_only' ? 'day_only' : 'appointment',
            })
            decided = true
            draft = narrowDraft(previousDraft, resumed, booking)
          }
        } catch (error) {
          console.error('[webhook/website] confirming the requested appointment failed', error)
          bookingFailed = true
        }
      }
      // What the row holds now: the draft as this message wrote it above, or as it was
      const onRow = arriving !== undefined ? arriving : previousDraft
      if (draft !== onRow && !bookingFailed) {
        // The partial booking as this message left it: narrowed by a refusal,
        // or gone once the lead holds the appointment or the request
        try {
          await saveContact({ supabase, clientId: channel.client_id, conversationId, sourceMessageId: userMessage.id, contact, events, draft })
        } catch (error) {
          console.error('[webhook/website] saving the partial booking failed', error)
        }
      }
      if (!result.appointment && booking.status === 'none' && !bookingFailed && result.reply.includes(APPOINTMENT_PLACEHOLDER)) {
        // The reply quotes an appointment the message didn't ask for (an
        // answer to "which branch?" that repeats the booking). If one is on
        // record, that is the one quoted; without this the reply would ask
        // for a day and time the visitor has already given.
        try {
          booking = await appointmentOnRecord({ supabase, conversationId })
        } catch (error) {
          console.error('[webhook/website] reading the appointment on record failed', error)
          bookingFailed = true
        }
      }
      // Read last, after every write of this message: what the reply may state as saved
      let record: SavedRecord = { name: null, phone: null }
      try {
        record = await savedRecord(supabase, conversationId)
      } catch (error) {
        console.error('[webhook/website] reading the lead on record failed', error)
      }
      // Only when the reply talks about the visitor's name and code may have
      // to ask the next question itself: is a day and time on record already?
      let timeOnRecord = booking.status !== 'none' && booking.status !== 'incomplete'
      if (!timeOnRecord && contact?.name && mentionsName(decided ? (result.otherAnswer ?? '') : result.reply)) {
        try {
          timeOnRecord = (await appointmentOnRecord({ supabase, conversationId })).status === 'booked'
        } catch (error) {
          console.error('[webhook/website] reading the appointment on record failed', error)
        }
      }
      trace = {
        raw: result.raw,
        booking: booking.status,
        ...(bookingFailed ? { booking_error: true } : {}),
        // Kept so a real time the detector missed can be found and counted
        ...(evidenceDropped.length > 0 ? { evidence_dropped: evidenceDropped } : {}),
        draft,
        contact,
        contact_events: events,
      }
      const language = replyLanguage(settings.language, message)
      reply = bookingFailed
        ? // The booking could not be written. Everything the visitor gave is on
          // the lead (written above) and the next message books it: they are
          // told so, never asked again, and never handed a booking that isn't one
          [decided ? result.otherAnswer : null, BOOKING_TEXTS[language].bookingSaveFailed].filter(Boolean).join('\n')
        : composeReply({
            template: result.reply,
            outcome: booking,
            events,
            record,
            visitorMessages,
            language,
            appointmentDecided: decided,
            otherAnswer: result.otherAnswer,
            rules,
            known: {
              name: contact.name,
              phone: contact.phone ?? record.phone,
              phoneGivenUp: contact.phoneRejections >= MAX_PHONE_REJECTIONS,
              time: timeOnRecord,
            },
          })
      // The visitor was told a person will take it from here: make that true.
      // 'no_answer' is the nearest reason the column allows today; a reason
      // of its own needs a migration.
      if (events.phone === 'rejected_final' || (booking.status === 'needs_details' && booking.handoff)) {
        await markForPerson('no_answer')
      }
      if (bookingFailed) await markForPerson('service_down')
    } catch (error) {
      console.error('[webhook/website] AI reply failed', error)
      // A failed reply (rate limit, timeout, 503) must not lose the lead: the
      // visitor's message is stored, so it's still analysed
      scheduleLeadDetection(history)

      // Nor leave the visitor with an error: they're told the service is
      // down (not the fallback message, which says the information is
      // missing), and the conversation is marked for a person to answer
      const { error: fallbackError } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        role: 'assistant',
        content: settings.service_unavailable_message,
        metadata: { fallback: 'ai_unavailable', reason: aiFailureReason(error) },
      })
      if (fallbackError) {
        console.error('[webhook/website] storing the fallback failed', fallbackError)
        return json({ ok: false, error: 'ai_unavailable', conversationId }, 502)
      }
      await markForPerson('service_down')
      return json({ ok: true, conversationId, reply: settings.service_unavailable_message, fallback: true })
    }

    const { error: replyError } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      role: 'assistant',
      content: reply,
      metadata: { model: replyModel(), ...trace },
    })
    if (replyError) {
      scheduleLeadDetection(history)
      throw replyError
    }

    // conversations.last_message_* is kept current by a trigger on messages
    const { error: usageError } = await supabase.rpc('consume_client_message', { p_client_id: channel.client_id })
    if (usageError) console.error('[webhook/website] counting the message failed', usageError)

    scheduleLeadDetection([...history, { role: 'assistant', content: reply }], true, contact)

    return json({ ok: true, conversationId, reply })
  } catch (error) {
    console.error('[webhook/website] POST', error)
    return json({ ok: false, error: 'server_error' }, 500)
  }
}
