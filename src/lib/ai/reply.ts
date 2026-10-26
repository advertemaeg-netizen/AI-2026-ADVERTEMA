import { after } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { aiFailureReason, replyModel, type ChatTurn } from '@/lib/ai/provider'
import { BOT_HISTORY_LIMIT, NoReplyError, loadBotSettings, runBot, type BotClient } from '@/lib/ai/bot'
import { detectLead } from '@/lib/ai/lead-detection'
import {
  APPOINTMENT_PLACEHOLDER,
  ASK_DAY_AND_TIME,
  NOTHING_SAID,
  appointmentLine,
  disputeLine,
  mergeDraft,
  narrowDraft,
  parseBookingDraft,
  replyLanguage,
  requestedDayKey,
  resolvesWhole,
  saysNothing,
  withoutTime,
  type AppointmentRequest,
  type BookingDraft,
  type BookingOutcome,
  type HoursInput,
  type ReplyRules,
} from '@/lib/ai/appointment'
import { branchInMessage, branchNamed, loadBookingBranches, type BookingBranch } from '@/lib/ai/branches'
import { withEvidence, type EvidencedPart } from '@/lib/ai/evidence'
import {
  appointmentOnRecord,
  bookingState,
  confirmPending,
  leadsOf,
  recheckOnRecord,
  recordAppointment,
  saveContact,
  savedRecord,
  type LeadsSink,
} from '@/lib/ai/booking'
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
import ar from '../../../messages/ar.json'
import en from '../../../messages/en.json'
import { checkClientLimit } from '@/lib/subscription-limits'
import type { NeedsHumanReason } from '@/lib/types/conversations'
import type { LimitCheck } from '@/lib/types/subscription'

const BOOKING_TEXTS = { ar: ar.botReplies.appointment, en: en.botReplies.appointment }

// What the bot states rather than asks: never sent twice in a row (5.4)
const STATEMENTS: BookingOutcome['status'][] = ['booked', 'kept', 'outside_hours', 'closed_date', 'past']

/**
 * What the pipeline did with the inbound message, for the transport to
 * deliver. `reply` and `fallback` carry the text the visitor gets; `handoff`
 * and `unavailable` deliver nothing (the website answers them with a flag and
 * a 502; the visitor's message is stored either way). The two fallbacks and
 * the three unavailable causes are kept apart: they differ in what was
 * written and why, even where the website answers them alike.
 */
export type ReplyOutcome =
  | { kind: 'reply'; reply: string }
  /** A person has taken over the conversation: the message is stored, nothing is answered */
  | { kind: 'handoff' }
  /** The service-unavailable text was written as the reply, with the cause (messages.metadata.fallback): the plan's limit, with the check's reason, or the model */
  | { kind: 'fallback'; reply: string; fallback: 'subscription_limit'; reason: LimitCheck['reason'] }
  | { kind: 'fallback'; reply: string; fallback: 'ai_unavailable' }
  /** Nothing was written and there is nothing to send */
  | { kind: 'unavailable'; reason: 'no_settings' | 'limit_check_failed' | 'fallback_write_failed' }

/** A message as the pipeline reads history: the trace a reply left in its metadata is read back from it */
export type HistoryRow = { role: string; content: string; metadata: { contact?: unknown; booking?: unknown; draft?: unknown } | null }

/**
 * WHERE THE CONVERSATION'S ROWS ARE. The pipeline decides; these calls are
 * its only way to rows. The caller picks the store: conversationStore() is
 * the database, the playground's keeps the rows in memory and hands them to
 * the browser. One path: the pipeline is never told which it has. The lead
 * rows have a sink of their own (LeadsSink, booking.ts), carried here.
 */
export type ReplyStore = {
  leads: LeadsSink
  /** The newest `limit` messages, newest first, as a fresh array: the pipeline reverses it in place */
  history(limit: number): Promise<HistoryRow[]>
  /** The bot's reply, or its fallback, as a message row; answers as the database does */
  insertReply(row: { content: string; metadata: Record<string, unknown> }): Promise<{ error: { message: string } | null }>
  /**
   * The visitor got no real answer: the conversation waits for a person, with
   * the cause, from the first message that happened to. Never fails the
   * request: the visitor has their message either way.
   */
  markForPerson(reason: NeedsHumanReason): Promise<void>
  /** One message of the client's monthly allowance (consume_client_message) */
  countMessage(): Promise<{ error: { message: string } | null }>
  /**
   * Lead detection once the reply is out. `businessHours` is a function
   * because it is read when the analysis runs, not when it is scheduled: the
   * branch as this message left it.
   */
  scheduleLeadDetection(args: {
    sourceMessageId: string | null
    history: ChatTurn[]
    replied: boolean
    businessHours: () => HoursInput
    contact: ContactState | null
  }): void
}

/**
 * The conversation's rows in the database. Lead detection is scheduled with
 * after(), so it never slows the reply; it runs whatever happened to the
 * reply, and detectLead itself decides whether the client's subscription
 * allows the analysis. after() nests: a transport that already runs the
 * pipeline after its response may call this (Next binds the request scope
 * into the callback and drains nested callbacks before the request's after
 * work is done).
 */
export function conversationStore({
  supabase,
  clientId,
  conversationId,
  source,
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  /** Names the transport in log lines */
  source: string
}): ReplyStore {
  return {
    leads: leadsOf(supabase, clientId, conversationId),
    async history(limit) {
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, metadata')
        .eq('conversation_id', conversationId)
        .in('role', ['user', 'assistant', 'agent'])
        .order('created_at', { ascending: false })
        .limit(limit)
        .returns<HistoryRow[]>()
      if (error) throw error
      return data
    },
    async insertReply(row) {
      // conversations.last_message_* is kept current by a trigger on messages
      const { error } = await supabase.from('messages').insert({ conversation_id: conversationId, role: 'assistant', ...row })
      return { error }
    },
    async markForPerson(reason) {
      const { error } = await supabase
        .from('conversations')
        .update({ needs_human_since: new Date().toISOString(), needs_human_reason: reason })
        .eq('id', conversationId)
        .is('needs_human_since', null)
      if (error) console.error(`[${source}] marking the conversation for a person failed`, error)
    },
    async countMessage() {
      const { error } = await supabase.rpc('consume_client_message', { p_client_id: clientId })
      return { error }
    },
    scheduleLeadDetection({ sourceMessageId, history, replied, businessHours, contact }) {
      after(() =>
        detectLead({ supabase, clientId, conversationId, sourceMessageId, history, replied, businessHours: businessHours(), contact })
      )
    },
  }
}

/**
 * THE ONE PIPELINE (.scratch/whatsapp-send-design.md §0). Everything that
 * happens to a visitor's message once the transport has a live channel, the
 * conversation and the stored inbound message: history, the lead as it
 * arrives, settings and branches, the plan's limit, the model, the booking,
 * the reply, the repeat guard, hand-off marking, the fallback, the reply row,
 * the usage count and lead detection. Moved from the website route so every
 * transport, and the playground, runs this code instead of a copy. Transport
 * stays in the route: parsing, rate limit, channel load, conversation lookup,
 * and the mapping from the outcome to a response.
 *
 * Rows are read and written only through `store`: the database for a
 * conversation, memory for a test chat. Throws are the caller's: a thrown
 * error here is a 500 on the website.
 */
export async function replyToMessage({
  supabase,
  channel,
  conversationId,
  autoReply,
  userMessage,
  message,
  store,
  source,
  settings: givenSettings,
  operation = 'chat_reply',
}: {
  /** Reads the client's settings, branches, limit and knowledge; rows go through `store` */
  supabase: SupabaseClient
  /** The live channel the message arrived on, with its client */
  channel: { client_id: string; clients: BotClient | null }
  /** The conversation, for the model's retrieval log and the log lines; its rows are the store's. None for a test chat */
  conversationId: string | null
  /** conversations.auto_reply_enabled: false once a person has taken over */
  autoReply: boolean
  /** The inbound message's row, already written; no row (a test chat) is null */
  userMessage: { id: string | null }
  /** The inbound message's text */
  message: string
  /** Where the conversation's rows are read and written */
  store: ReplyStore
  /** Names the transport in log lines: 'webhook/website', 'webhook/meta', 'playground' */
  source: string
  /** The client's bot settings when the caller has them (a settings preview); read here otherwise */
  settings?: BotSettingsInput
  /** What the reply's tokens are logged as (ai_usage) */
  operation?: Parameters<typeof runBot>[0]['operation']
}): Promise<ReplyOutcome> {
  const recent = await store.history(BOT_HISTORY_LIMIT)

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
  // The bot's own last message (not a person's): a statement is never sent twice in a row (5.4)
  const previousBotReply = recent.findLast((m) => m.role === 'assistant')?.content ?? null

  // A NUMBER THE VISITOR TYPED IS ALWAYS SAVED. It belongs to the person who
  // typed it, expecting a call: no plan limit, takeover or failure may
  // discard it. So code reads it first — before a person's takeover, before
  // the plan's limits, before the model is called — and writes it. Reading
  // it costs nothing. A plan decides what a client may SEE, never what is
  // stored. (The name needs the model's report; it is read with the reply.)
  const early = readContact(previousContact, null, message, visitorMessages)
  if (early.events.phone === 'stored') {
    try {
      await saveContact({
        leads: store.leads,
        sourceMessageId: userMessage.id,
        contact: { ...previousContact, phone: early.state.phone },
        events: { name: 'none', phone: 'stored' },
      })
    } catch (error) {
      console.error(`[${source}] saving the phone number failed`, error)
    }
  }

  let settings: BotSettingsInput | null = givenSettings ?? null
  try {
    settings ??= await loadBotSettings(supabase, channel.client_id)
  } catch (error) {
    console.error(`[${source}] loading bot settings failed`, error)
  }

  // The client's active branches: the hours a booking is checked against,
  // and the ones the prompt states. Unread, nothing is checked (every
  // booking is a request) and no hours are stated: it never blocks a reply.
  let branches: BookingBranch[] = []
  try {
    branches = await loadBookingBranches(supabase, channel.client_id)
  } catch (error) {
    console.error(`[${source}] reading the branches failed`, error)
  }
  // More than one: the visitor's branch is a step of its own. One: it is the branch, never asked about
  const severalBranches = branches.length > 1
  // The branch this conversation's booking is for, once known
  let branch: BookingBranch | null = severalBranches ? null : (branches[0] ?? null)

  // Lead detection runs once the reply is out (the store's after()), so it
  // never slows the reply, and it runs whatever happens to the reply.
  const scheduleLeadDetection = (turns: ChatTurn[], replied = false, contact: ContactState | null = null) => {
    // Always: a lead's name and number never depend on a switch
    store.scheduleLeadDetection({
      sourceMessageId: userMessage.id,
      history: turns,
      replied,
      // Read when the analysis runs, after the reply: the branch as this message left it
      businessHours: () => branch?.schedule ?? null,
      contact,
    })
  }

  // A human agent has taken over: store the message, skip the AI. The
  // agent's reply reaches the widget over Realtime broadcast. Visitors often
  // share their details at this point, so still look for a lead.
  if (!autoReply) {
    scheduleLeadDetection(history)
    return { kind: 'handoff' }
  }

  if (!settings) {
    scheduleLeadDetection(history)
    return { kind: 'unavailable', reason: 'no_settings' }
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
    console.error(`[${source}] limit check failed`, error)
    scheduleLeadDetection(history)
    return { kind: 'unavailable', reason: 'limit_check_failed' }
  }
  if (quota && !quota.allowed) {
    const { error: fallbackError } = await store.insertReply({
            content: settings.service_unavailable_message,
      metadata: { fallback: 'subscription_limit', reason: quota.reason },
    })
    if (fallbackError) throw fallbackError
    await store.markForPerson(quota.reason === 'inactive' ? 'inactive' : 'limit_reached')
    // Past the limit, leads are still captured up to the ceiling
    scheduleLeadDetection([...history, { role: 'assistant', content: settings.service_unavailable_message }])
    return { kind: 'fallback', reply: settings.service_unavailable_message, fallback: 'subscription_limit', reason: quota.reason }
  }

  let reply: string
  // Stored with the reply: what the model answered, and what became of the
  // appointment it reported
  let trace: {
    raw: string
    booking: BookingOutcome['status']
    booking_error?: true
    /** The same statement would have gone out twice in a row (5.4) */
    repeat_stopped?: true
    evidence_dropped?: EvidencedPart[]
    /** What the visitor has said toward an appointment that is not one yet; the next message starts from here */
    draft: BookingDraft | null
    /** The name and number as code holds them after this message; the next message starts from here */
    contact?: ContactState
    contact_events?: ContactEvents
  }
  let contact: ContactState | null = null
  // The model's answer as it came, once there is one: stored with a
  // fallback too, so a failure after the model answered can be read from
  // the message instead of reconstructed from logs
  let raw: string | null = null
  // The business's booking shape, and how much of a name it asks for
  const mode = effectiveBookingMode(settings)

  // The open lead as it stands: a day (and time) held for the visitor's
  // details, and the partial booking written so far. Unread, the message
  // trace stands in: it never blocks a reply.
  let held = false
  let previousDraft = tracedDraft
  let leadBranchId: string | null = null
  try {
    const state = await bookingState(store.leads)
    held = state.held
    if (state.hasDraft) previousDraft = state.draft
    leadBranchId = state.branchId
  } catch (error) {
    console.error(`[${source}] reading the open lead failed`, error)
  }
  // The branch chosen earlier: the draft's, or the one a held day was recorded for
  if (severalBranches) {
    branch = branchNamed(branches, previousDraft?.branch ?? null) ?? branches.find((b) => b.id === leadBranchId) ?? null
  }
  // A partial booking that is already whole: written before a booking that
  // failed (5.2). It is booked on this message, whatever it is about, and the
  // visitor is not asked again for what they gave.
  const resumable =
    mode !== 'none' &&
    previousDraft !== null &&
    (!severalBranches || branch !== null) &&
    resolvesWhole(previousDraft, mode, branch?.schedule ?? null)

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
      operation,
      conversationId,
      knownContact: previousContact,
      heldRequest: held,
      branches,
    })
    raw = result.raw

    // The model reported; code decides. The name and the number are
    // checked and written before the reply is rendered, so the reply can
    // only state what the lead row holds. Always: the name and the number
    // are the product, and no setting turns them off.
    const read = readContact(previousContact, result.contact, message, visitorMessages, settings.name_strictness)
    contact = read.state
    const events: ContactEvents = read.events
    let booking: BookingOutcome = { status: 'none' }
    let bookingFailed = false
    // What the model reported that the message gave no trace of
    let evidenceDropped: EvidencedPart[] = []
    // Code decided something about the appointment on this message: then
    // code alone speaks about it (composeReply)
    let decided = result.appointment !== null

    // The branch this message names, if the visitor's own words name one
    // (branchInMessage): it is the branch from here on, held in the draft
    const named = severalBranches && mode !== 'none' ? branchInMessage(branches, message, result.branch) : null
    const branchChosenNow = named !== null && named.id !== branch?.id
    if (named) branch = named
    const startDraft: BookingDraft | null =
      severalBranches && branch && previousDraft?.branch !== branch.name
        ? { day: previousDraft?.day ?? null, time: previousDraft?.time ?? null, branch: branch.name }
        : previousDraft
    // Kept as it was unless this message reported something about the appointment
    let draft = startDraft

    // Only what this message shows a trace of (withEvidence), completed with
    // what earlier ones gave (the draft). A day-only business takes no time,
    // whatever the model reported.
    let request: AppointmentRequest | null = null
    if (result.appointment) {
      const evidenced = withEvidence(result.appointment, message)
      evidenceDropped = evidenced.dropped
      const merged = mergeDraft(startDraft, evidenced.request)
      request = mode === 'day_only' ? withoutTime(merged) : merged
    } else if (branchChosenNow && (startDraft?.day || startDraft?.time)) {
      // The answer to "which branch?": the day held for it is checked now
      const merged = mergeDraft(startDraft, NOTHING_SAID)
      request = mode === 'day_only' ? withoutTime(merged) : merged
      decided = true
    }
    // THE LEAD AS IT ARRIVES: the name, the number, and the partial booking
    // with what this message added, written now — before anything is booked,
    // so nothing given can be lost to a failure further on
    const arriving = request && !saysNothing(request) ? narrowDraft(startDraft, request, ASK_DAY_AND_TIME) : undefined
    try {
      await saveContact({
        leads: store.leads,
        sourceMessageId: userMessage.id,
        contact,
        events,
        ...(arriving !== undefined ? { draft: arriving } : {}),
      })
    } catch (error) {
      // Not saved: the reply states the record, so it will say so
      console.error(`[${source}] saving the lead failed`, error)
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
            (await confirmPending({ leads: store.leads, businessHours: branch?.schedule ?? null, contact })) ??
            (await appointmentOnRecord(store.leads))
          if (booking.status === 'none') booking = ASK_DAY_AND_TIME
        } else if (severalBranches && !branch) {
          // No day can be checked before the branch is known: what was said
          // is held, and named in the question
          booking = { status: 'ask_branch', day: requestedDayKey(request), branches: branches.map((b) => b.name) }
        } else {
          booking = await recordAppointment({
            leads: store.leads,
            sourceMessageId: userMessage.id,
            request,
            autoConfirm: settings.auto_confirm_appointments,
            businessHours: branch?.schedule ?? null,
            branch,
            source: 'reply',
            contact,
            // The visitor is here to be asked the hour rather than given a guess at one
            hourFromPartOfDay: false,
            mode: mode === 'day_only' ? 'day_only' : 'appointment',
          })
        }
        draft = narrowDraft(startDraft, request, booking)
      } catch (error) {
        console.error(`[${source}] recording the appointment failed`, error)
        bookingFailed = true
        // As written above: what the visitor gave stays, for the next message to book
        draft = arriving ?? startDraft
      }
    } else if (mode !== 'none') {
      // A time asked for earlier, held back for a name or a number: once
      // both are on record it becomes the appointment, whatever this
      // message is about; until then code asks for the next one. A partial
      // booking already whole (a booking write that failed) is booked the
      // same way.
      try {
        const promoted = await confirmPending({ leads: store.leads, businessHours: branch?.schedule ?? null, contact })
        if (promoted) {
          booking = promoted
          decided = true
          draft = null
        } else if (resumable && startDraft) {
          const resumed = mergeDraft(startDraft, NOTHING_SAID)
          booking = await recordAppointment({
            leads: store.leads,
            sourceMessageId: userMessage.id,
            request: resumed,
            autoConfirm: settings.auto_confirm_appointments,
            businessHours: branch?.schedule ?? null,
            branch,
            source: 'reply',
            contact,
            hourFromPartOfDay: false,
            mode: mode === 'day_only' ? 'day_only' : 'appointment',
          })
          decided = true
          draft = narrowDraft(startDraft, resumed, booking)
        }
      } catch (error) {
        console.error(`[${source}] confirming the requested appointment failed`, error)
        bookingFailed = true
      }
    }
    // What the row holds now: the draft as this message wrote it above, or as it was
    const onRow = arriving !== undefined ? arriving : previousDraft
    if (draft !== onRow && !bookingFailed) {
      // The partial booking as this message left it: narrowed by a refusal,
      // or gone once the lead holds the appointment or the request
      try {
        await saveContact({ leads: store.leads, sourceMessageId: userMessage.id, contact, events, draft })
      } catch (error) {
        console.error(`[${source}] saving the partial booking failed`, error)
      }
    }
    if (!result.appointment && booking.status === 'none' && !bookingFailed && result.reply.includes(APPOINTMENT_PLACEHOLDER)) {
      // The reply quotes an appointment the message didn't ask for (an
      // answer to "which branch?" that repeats the booking). If one is on
      // record, that is the one quoted; without this the reply would ask
      // for a day and time the visitor has already given.
      try {
        booking = await appointmentOnRecord(store.leads)
      } catch (error) {
        console.error(`[${source}] reading the appointment on record failed`, error)
        bookingFailed = true
      }
    }
    // Read last, after every write of this message: what the reply may state as saved
    let record: SavedRecord = { name: null, phone: null }
    try {
      record = await savedRecord(store.leads)
    } catch (error) {
      console.error(`[${source}] reading the lead on record failed`, error)
    }
    // Only when the reply talks about the visitor's name and code may have
    // to ask the next question itself: is a day and time on record already?
    let timeOnRecord = !['none', 'incomplete', 'ask_branch', 'closed_date', 'no_open_days'].includes(booking.status)
    if (!timeOnRecord && contact?.name && mentionsName(decided ? (result.otherAnswer ?? '') : result.reply)) {
      try {
        timeOnRecord = (await appointmentOnRecord(store.leads)).status === 'booked'
      } catch (error) {
        console.error(`[${source}] reading the appointment on record failed`, error)
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
    // A refusal names the branch when there is more than one to tell apart
    const rules: ReplyRules = { mode, nameStrictness: settings.name_strictness, branch: severalBranches ? (branch?.name ?? null) : null }
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

    // NEVER THE SAME STATEMENT TWICE IN A ROW (5.4). A visit on record or a
    // refusal about to go out word for word again means the visitor pushed
    // back («م انت قلت المواعيد من 1», «انت غبي»): saying it again is never
    // the answer. The visit is checked again against its branch; one those
    // hours refuse is cleared and the refusal said (another day is asked
    // for); otherwise the bot says something is wrong and a person takes
    // over. Either way a person is told it happened. Questions (the day,
    // the name, the number) are not statements: asking again is allowed.
    let repeatStopped = false
    if (
      !bookingFailed &&
      previousBotReply !== null &&
      reply.trim() === previousBotReply.trim() &&
      STATEMENTS.includes(booking.status)
    ) {
      repeatStopped = true
      const repeated = booking.status
      let refused: BookingOutcome | null = null
      if (booking.status === 'booked' || booking.status === 'kept') {
        try {
          refused = await recheckOnRecord({ leads: store.leads, businessHours: branch?.schedule ?? null })
        } catch (error) {
          console.error(`[${source}] checking the visit on record again failed`, error)
        }
      }
      if (refused) {
        booking = refused
        // The day is gone from the record; the branch stays for the next one
        draft = branch && severalBranches ? { day: null, time: null, branch: branch.name } : null
        trace.booking = refused.status
        trace.draft = draft
        try {
          await saveContact({ leads: store.leads, sourceMessageId: userMessage.id, contact, events, draft })
        } catch (error) {
          console.error(`[${source}] saving the partial booking failed`, error)
        }
      }
      reply = refused ? appointmentLine(refused, language, rules) : disputeLine(language)
      trace.repeat_stopped = true
      console.error(
        `[booking] conversation ${conversationId}: the same ${repeated} statement would have gone out twice; ${refused ? 'the visit was cleared and refused' : 'handed to a person'}`
      )
    }
    // The visitor was told a person will take it from here: make that true.
    // 'no_answer' is the nearest reason the column allows today; a reason
    // of its own needs a migration.
    if (booking.status === 'no_open_days') {
      // A branch marked active whose hours open on no day: the client
      // half-configured it and nothing on their side says so. The visitor
      // was told a person will be in touch.
      console.error(
        `[booking] client ${channel.client_id}: branch ${branch?.id ?? '(none)'} is active but its hours open on no day; conversation ${conversationId} handed to a person`
      )
    }
    if (
      events.phone === 'rejected_final' ||
      (booking.status === 'needs_details' && booking.handoff) ||
      booking.status === 'no_open_days' ||
      repeatStopped
    ) {
      await store.markForPerson('no_answer')
    }
    if (bookingFailed) await store.markForPerson('service_down')
    // AN EMPTY REPLY IS A FAILURE ONLY HERE: the model wrote nothing (no
    // reply, no other_answer) AND code had nothing of its own to say. Any
    // booking sentence, refusal, question or follow-up of code's makes the
    // empty reply correct, which is what the model is told it may be.
    if (!reply.trim()) throw new NoReplyError()
  } catch (error) {
    console.error(`[${source}] AI reply failed`, error)
    // A failed reply (rate limit, timeout, 503) must not lose the lead: the
    // visitor's message is stored, so it's still analysed
    scheduleLeadDetection(history)

    // Nor leave the visitor with an error: they're told the service is
    // down (not the fallback message, which says the information is
    // missing), and the conversation is marked for a person to answer
    const { error: fallbackError } = await store.insertReply({
            content: settings.service_unavailable_message,
      metadata: {
        fallback: 'ai_unavailable',
        reason: aiFailureReason(error),
        // What failed, and what the model had answered if it had: the two
        // service-down replies of 21–22 October took three days to explain
        // because neither was kept
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        ...(raw !== null ? { raw } : {}),
      },
    })
    if (fallbackError) {
      console.error(`[${source}] storing the fallback failed`, fallbackError)
      return { kind: 'unavailable', reason: 'fallback_write_failed' }
    }
    await store.markForPerson('service_down')
    return { kind: 'fallback', reply: settings.service_unavailable_message, fallback: 'ai_unavailable' }
  }

  const { error: replyError } = await store.insertReply({
        content: reply,
    metadata: { model: replyModel(), ...trace },
  })
  if (replyError) {
    scheduleLeadDetection(history)
    throw replyError
  }

  const { error: usageError } = await store.countMessage()
  if (usageError) console.error(`[${source}] counting the message failed`, usageError)

  scheduleLeadDetection([...history, { role: 'assistant', content: reply }], true, contact)

  return { kind: 'reply', reply }
}
