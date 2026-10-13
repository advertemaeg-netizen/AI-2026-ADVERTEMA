/**
 * Provider evaluation (eval/RUNNER.md): the 36 cases in eval/cases.json, each
 * run 3 times as a fresh conversation against the demo clinic's real bot.
 *
 *   npm run eval -- --provider=gemini
 *   npm run eval -- --provider=openai
 *   npm run eval -- --provider=gemini --only=AM01,PR03 --repeats=1   a quick look
 *   npm run eval -- --provider=openai --cases=phase1   eval/cases-phase1.json, scored on its own
 *
 * eval/cases.json is frozen: a set that changes can't be compared with its
 * own earlier scores. Cases written since go in a file of their own
 * (--cases=<name> reads eval/cases-<name>.json) and are scored separately.
 *
 * Calls runBot directly as a `playground` operation: nothing counts against
 * the demo's 300 messages, and no conversation, message or lead is written.
 * What production would have recorded is worked out the way production does
 * it, in memory: the name and number through readContact, the appointment
 * through resolveAppointment and the booking gate (as recordAppointment would
 * store it: a time-only change keeping the day, and no appointment without a
 * name and a valid phone number), the reply through composeReply, the rest of
 * the lead through analyzeConversation (as detectLead would read it). The only
 * rows written are the calls' own ai_usage rows, which is where the tokens
 * and the cost in the results come from.
 *
 * This compares providers; it is not an end-to-end test. Only the model's
 * output differs between two runs: the code that turns it into an
 * appointment and a reply is the same pure code for both, given what the
 * webhook gives it. The webhook, the database writes and the widget are not
 * exercised.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { loadBotSettings, runBot, type BotClient } from '@/lib/ai/bot'
import {
  APPOINTMENT_PLACEHOLDER,
  confirmsItself,
  openingAt,
  replyLanguage,
  resolveAppointment,
  sameInstant,
  type AppointmentRequest,
  type BookingOutcome,
} from '@/lib/ai/appointment'
import { composeReply, type SavedRecord } from '@/lib/ai/compose'
import { EMPTY_CONTACT, MAX_PHONE_REJECTIONS, missingDetails, readContact, type ContactEvents } from '@/lib/ai/contact'
import { LEAD_CONFIDENCE_THRESHOLD, analyzeConversation } from '@/lib/ai/lead-detection'
import { aiFailureReason, replyModel, type ChatTurn } from '@/lib/ai/provider'
import { cairoParts } from '@/lib/cairo-time'
import { createAdminClient } from '@/lib/supabase/admin'
import { findDemo, type Admin } from './seed-demo'

const ROOT = process.cwd()
const EVAL_DIR = path.join(ROOT, 'eval')
const PRODUCTION_TEMPERATURE = 0.7
// What production runs (GOOGLE_GEMINI_MODEL there), not the default in the
// code: the baseline is only a baseline on this model
const GEMINI_BASELINE_MODEL = 'gemini-3-flash-preview'
// Written at the top of every results file
const RESULTS_NOTE =
  'Provider comparison, NOT an end-to-end test. runBot is called directly; appointments and leads are worked out in memory ' +
  'by the same pure code for every provider (readContact, resolveAppointment, the booking gate, composeReply, analyzeConversation). The webhook, the database ' +
  'writes (saveContact, recordAppointment, detectLead) and the widget are not exercised: a pass here is not evidence that the full path works.'
const EMERGENCY_NUMBER = '01002847562'
const PRICE_GROUP = 'الأسعار'
// A 429 is the quota, not the model's answer: the run waits and starts over
const RATE_LIMIT_WAITS_MS = [20_000, 40_000, 60_000]
const USAGE_WAIT_MS = 10_000

type ExpectedAppointment = null | 'asks_for_time' | { day_offset: number | string; hour: number; minute: number }
type Expect = {
  contains_all?: string[][]
  not_contains?: string[]
  appointment?: ExpectedAppointment
  appointment_hour_in?: number[]
  must_not_claim_booking?: boolean
  lead?: { name?: string; phone_contains?: string; service_contains?: string[] }
  defers_to_team?: boolean
  emergency_number?: boolean
  no_invented_price?: boolean
  /** The phone number the lead row would hold at the end, as E.164; null = none may be stored */
  phone_on_record?: string | null
  /** Whether the lead would be flagged name_incomplete */
  name_incomplete?: boolean
  /** No reply may hold Chinese, Japanese or Korean script */
  no_cjk?: boolean
  /** The last reply steers back to the business (declining alone is not enough) */
  redirects?: boolean
}
type Case = {
  id: string
  group: string
  turns: string[]
  expect: Expect
  /** Which replies the text assertions read: the last one, unless 'all' */
  search?: 'all'
  why?: string
}

type Assertion = { name: string; passed: boolean; detail: string; critical?: true }
type UsageRow = {
  id: string
  operation: string
  model: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  estimated_cost_usd: number | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

/** Arabic-Indic digits → Latin, thousands separators dropped: ٦٥٠٠٠ = 65,000 = 65000 */
function normalize(text: string) {
  return text
    .replace(/[٠-٩۰-۹]/g, (d) => String('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(d) % 10))
    .replace(/٪/g, '%')
    .replace(/(?<=\d)[,٬،](?=\d{3}(?!\d))/g, '')
}

/**
 * Arabic as it is compared, not as it is spelled. The same word is written
 * several ways and a comparison must not tell them apart: حالاً / حالًا (the
 * tanween before or after the alef), أ إ آ / ا, ى / ي, ة / ه, with or without
 * tashkeel and tatweel, with one space or several.
 *
 * Seen on 13 October 2026: EM01 and EM02 failed on replies that said "اتصل
 * حالًا" and "فورًا" because the cases spell them حالاً and فوراً.
 */
export function foldArabic(text: string) {
  return text
    .replace(/[ؐ-ًؚ-ٰٟۖ-ۭـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
}

/**
 * Both sides are folded (numbers, then Arabic spelling) before the search.
 * A needle that starts or ends with a digit must not continue into another
 * digit there: "500" is not found in "4500", nor "3" in "13".
 */
export function contains(haystack: string, needle: string) {
  const n = foldArabic(normalize(needle))
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${/^\d/.test(n) ? '(?<!\\d)' : ''}${escaped}${/\d$/.test(n) ? '(?!\\d)' : ''}`).test(
    foldArabic(normalize(haystack))
  )
}

/** Without tashkeel or tatweel: اتسجّل = اتسجل */
const plain = (text: string) => text.replace(/[\u064B-\u0652\u0640]/g, '')

// Wording that states a booking as done, read on plain() text. A second net
// only: whether something was booked is the booking outcome, a fact. This
// catches a reply that says so in its own words after nothing was booked.
// Written before any real reply had been seen: eval/RUNNER.md requires
// reading what it caught, and what it let through, after the first run.
const BOOKING_CLAIM_PHRASES = [
  'حجزتلك',
  'حجزت لك',
  'حجزنالك',
  'حجزنا لك',
  'تم الحجز',
  'تم حجز',
  'الحجز تم',
  'خلصنا الحجز',
  'اتحجز',
  'اتسجل',
  'تم تسجيل',
  'تم تأكيد',
  'مستنيينك',
  'مستنينك',
  'appointment is booked',
  'appointment is confirmed',
  'booking is confirmed',
  "i've booked",
  'i have booked',
]
// "Your appointment" (ميعادك / موعدك) is a claim by what its sentence does
// with it. Stated as settled, always:
const YOUR_APPOINTMENT = /ميعادك|موعدك/
const APPOINTMENT_AFFIRMED = /(ميعادك|موعدك)\s+(اتأكد|اتاكد|مؤكد|متأكد|محجوز|اتسجل|اتحجز|جاهز)/
// Otherwise when the sentence isn't a question ("ميعادك الخميس 6" is a
// claim, "تحب ميعادك إمتى؟" is not) and isn't about cancelling one
// ("الفريق هيتواصل لإلغاء ميعادك")
// Known gap, left open on purpose (eval/RUNNER.md): a claim and a question
// in one sentence pass ("ميعادك الأسبوع الجاي، تحب يوم إيه؟")
const QUESTION = /[?؟]|(?<![ء-ي])([إا]يه|[إا]مت[ىي]|فين)(?![ء-ي])/
const CANCELLING = /[إا]لغا|لغي|اتلغ[ىي]|ملغ[يى]/
// Sentences as renderReply splits them
const sentencesOf = (text: string) => text.split(/(?<=[.!?؟…\n])/)

/** The booking wording found in a reply; empty when it claims nothing */
export function bookingClaimIn(reply: string) {
  const text = plain(reply).toLowerCase()
  const found = BOOKING_CLAIM_PHRASES.filter((phrase) => text.includes(phrase))
  for (const sentence of sentencesOf(text)) {
    if (!YOUR_APPOINTMENT.test(sentence)) continue
    if (APPOINTMENT_AFFIRMED.test(sentence)) found.push(`"${sentence.trim()}" (stated as settled)`)
    else if (!QUESTION.test(sentence) && !CANCELLING.test(sentence)) found.push(`"${sentence.trim()}" (not a question)`)
  }
  return found
}
// A question about the day or the time
const TIME_QUESTION = /الساعة|ساعة كام|[إا]مت[ىي]|[أا]ي يوم|[أا]نهي يوم|يوم [إا]يه|وقت|ميعاد|معاد|موعد|الصبح|بالليل|what time|which day|when/i
const DEFERS_TO_TEAM = /الفريق|فريقنا|هنرد|هيرد|هنتواصل|هيتواصل|هنتأكد|خدمة العملاء/
// Han, kana and hangul
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff]/
// What the bot is here for, named in the reply. Wide on purpose: the case is
// failed by the answer appearing (not_contains), this only asks that the
// reply points somewhere
const BACK_TO_BUSINESS = /عياد|[أا]سنان|حجز|ميعاد|موعد|خدم|[أا]سعار|[أا]ساعدك|clinic|dental|appointment|book/i

/** Every number written in the knowledge base */
function knowledgeBaseNumbers() {
  const dir = path.join(ROOT, 'demo/kb')
  const numbers = new Set<string>()
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    for (const n of normalize(readFileSync(path.join(dir, file), 'utf8')).match(/\d+(?:\.\d+)?/g) ?? []) numbers.add(n)
  }
  return numbers
}

/** Amounts in pounds stated in a reply */
function pricesIn(text: string) {
  const currency = '(?:جنيه|جنيها|ج\\.?م|EGP|LE|L\\.E\\.?)'
  const found = [
    ...text.matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${currency}`, 'gi')),
    ...text.matchAll(new RegExp(`${currency}\\s*(\\d+(?:\\.\\d+)?)`, 'gi')),
  ]
  return [...new Set(found.map((m) => m[1]))]
}

// ---------------------------------------------------------------------------
// One run of one case
// ---------------------------------------------------------------------------

type Bot = {
  admin: Admin
  clientId: string
  client: BotClient
  settings: Awaited<ReturnType<typeof loadBotSettings>>
  kbNumbers: Set<string>
}

type TurnRecord = {
  user: string
  /** The model's answer before anything read it */
  raw: string
  appointmentRequest: AppointmentRequest | null
  booking: BookingOutcome
  /** What became of the name and number in this message */
  contact: ContactEvents
  /** What the visitor would have been sent */
  reply: string
  /** The appointment on record once this turn was answered */
  appointmentAt: string | null
  retrievalError: boolean
}

async function converse(bot: Bot, turns: string[]) {
  const { settings } = bot
  const history: ChatTurn[] = []
  const records: TurnRecord[] = []
  let appointmentAt: string | null = null
  // The lead row as production would leave it: saveContact and
  // recordAppointment, without the database
  let contact = EMPTY_CONTACT
  let record: SavedRecord = { name: null, phone: null }
  let leadOpen = false
  /** A time asked for while the name or the number was missing (ai_appointment.pending) */
  let pending: { at: string; confirmed: boolean } | null = null
  const said: string[] = []
  const hours = settings.business_hours

  for (const user of turns) {
    said.push(user)
    history.push({ role: 'user', content: user })
    const result = await runBot({
      supabase: bot.admin,
      clientId: bot.clientId,
      client: bot.client,
      settings,
      history,
      operation: 'playground',
      knownContact: contact,
    })

    // saveContact: the name and number code accepts go on the open lead; a
    // valid number opens one
    const read = readContact(contact, result.contact, user, said)
    contact = read.state
    if (read.events.phone === 'stored') leadOpen = true
    const fill = () => {
      if (leadOpen) record = { name: contact.name ?? record.name, phone: contact.phone ?? record.phone }
    }
    fill()

    // recordAppointment without the lead row: the assistant's own time, moved freely
    let booking: BookingOutcome = { status: 'none' }
    let confirmedOnRecord = false
    if (result.appointment) {
      const resolved = resolveAppointment(result.appointment, { keepDayOf: appointmentAt ?? pending?.at ?? null, businessHours: hours })
      if (resolved.status === 'resolved') {
        // A booking opens the lead, with what is known of the visitor
        leadOpen = true
        fill()
        const missing = missingDetails(record.name, record.phone)
        const confirmed = confirmsItself(settings.auto_confirm_appointments, resolved.validated, result.appointment.needs_team_check === true)
        if (missing.length > 0) {
          if (!appointmentAt) pending = { at: resolved.at, confirmed }
          booking = {
            status: 'needs_details',
            at: resolved.at,
            missing,
            handoff: missing.includes('phone') && contact.phoneRejections >= MAX_PHONE_REJECTIONS,
          }
        } else {
          const changed = !sameInstant(appointmentAt, resolved.at)
          appointmentAt = resolved.at
          pending = null
          confirmedOnRecord = confirmed
          booking = { status: 'booked', at: resolved.at, confirmed, changed }
        }
      } else {
        booking = resolved
      }
    } else if (pending && !appointmentAt && missingDetails(record.name, record.phone).length === 0) {
      // confirmPending: the time asked for earlier becomes the appointment
      const waiting = pending
      pending = null
      const opening = hours?.enabled ? openingAt(hours, waiting.at) : null
      if (new Date(waiting.at).getTime() < Date.now()) booking = { status: 'past' }
      else if (opening && !opening.open) booking = { status: 'outside_hours', hours: opening.day }
      else {
        appointmentAt = waiting.at
        confirmedOnRecord = waiting.confirmed
        booking = { status: 'booked', at: waiting.at, confirmed: waiting.confirmed, changed: true }
      }
    } else if (appointmentAt && result.reply.includes(APPOINTMENT_PLACEHOLDER)) {
      // appointmentOnRecord: a reply that quotes the appointment without
      // reporting it again is answered from the record, as the webhook does
      booking = { status: 'booked', at: appointmentAt, confirmed: confirmedOnRecord, changed: false }
    }
    const reply = composeReply({
      template: result.reply,
      outcome: booking,
      events: read.events,
      record,
      visitorMessages: said,
      language: replyLanguage(settings.language, user),
      appointmentReported: result.appointment !== null,
    })
    history.push({ role: 'assistant', content: reply })
    records.push({
      user,
      raw: result.raw,
      appointmentRequest: result.appointment,
      booking,
      contact: read.events,
      reply,
      appointmentAt,
      retrievalError: result.debug.retrievalError,
    })
  }
  return { history, records, appointmentAt, contact, record, leadOpen }
}

type Conversation = Awaited<ReturnType<typeof converse>>

/**
 * The lead detectLead would have left. The name and number are the ones code
 * accepted while answering (detectLead takes them from there, not from the
 * analysis); the lead is open already when a number or a booking opened it,
 * otherwise intent with a name opens it.
 */
async function leadFrom(bot: Bot, conversation: Conversation) {
  const analysis = await analyzeConversation(conversation.history, { operation: 'lead_analysis', clientId: bot.clientId })
  const { name, phone } = conversation.contact
  const qualifies = analysis.is_lead && analysis.confidence >= LEAD_CONFIDENCE_THRESHOLD && (phone !== null || name !== null)
  return {
    recorded: conversation.leadOpen || qualifies,
    name,
    phone,
    service_requested: analysis.service_requested,
    branch: analysis.branch,
    confidence: analysis.confidence,
    is_lead: analysis.is_lead,
  }
}

/** The Cairo day and time an expected appointment stands for, from today */
function expectedSlot(expected: { day_offset: number | string; hour: number; minute: number }, now: Date) {
  const today = cairoParts(now)
  const time = `${String(expected.hour).padStart(2, '0')}:${String(expected.minute).padStart(2, '0')}`
  let offset: number
  if (typeof expected.day_offset === 'number') {
    offset = expected.day_offset
  } else {
    // "next_sunday": the nearest one still to come (today counts until that time has passed)
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(
      expected.day_offset.replace(/^next_/, '')
    )
    if (weekday < 0) throw new Error(`unknown day_offset "${expected.day_offset}"`)
    const todayWeekday = new Date(Date.UTC(today.year, today.month, today.day)).getUTCDay()
    offset = (weekday - todayWeekday + 7) % 7
    if (offset === 0 && time <= today.time) offset = 7
  }
  const day = new Date(Date.UTC(today.year, today.month, today.day + offset))
  return `${day.toISOString().slice(0, 10)} ${time}`
}

const slotOf = (at: string) => `${cairoParts(at).dateKey} ${cairoParts(at).time}`

function check(
  testCase: Case,
  records: TurnRecord[],
  appointmentAt: string | null,
  lead: Awaited<ReturnType<typeof leadFrom>> | null,
  bot: Bot,
  now: Date,
  conversation: Conversation
): Assertion[] {
  const { expect } = testCase
  const replies = records.map((r) => normalize(r.reply))
  const last = replies[replies.length - 1]
  // The last reply is the one the case is about; reading them all lets an
  // earlier turn pass for it. A case that needs them all says so (LC01)
  const searched = testCase.search === 'all' ? replies : [last]
  const text = searched.join('\n')
  const scope = testCase.search === 'all' ? `any of the ${replies.length} replies` : 'the last reply'
  const results: Assertion[] = []
  const add = (name: string, passed: boolean, detail: string, critical = false) =>
    results.push({ name, passed, detail, ...(critical && !passed ? { critical: true as const } : {}) })

  for (const group of expect.contains_all ?? []) {
    const found = group.some((needle) => contains(text, needle))
    add(`contains_all [${group.join(' | ')}]`, found, found ? `found in ${scope}` : `none of the alternatives appears in ${scope}`)
  }
  if (expect.not_contains) {
    const found = expect.not_contains.filter((needle) => contains(text, needle))
    add(
      'not_contains',
      found.length === 0,
      found.length === 0 ? `none appears in ${scope}` : `appears in ${scope}: ${found.join(', ')}`,
      testCase.group === PRICE_GROUP
    )
  }

  if (expect.appointment === null) {
    add('appointment: null', appointmentAt === null, appointmentAt ? `recorded ${slotOf(appointmentAt)}` : 'none recorded')
  } else if (expect.appointment === 'asks_for_time') {
    const asks =
      records[records.length - 1].booking.status === 'ask_period' || (/[?؟]/.test(last) && TIME_QUESTION.test(last))
    add(
      'appointment: asks_for_time',
      appointmentAt === null && asks,
      appointmentAt
        ? `recorded ${slotOf(appointmentAt)}`
        : asks
          ? 'none recorded, and the reply asks for the time'
          : 'none recorded, but the reply does not ask for the time'
    )
  } else if (expect.appointment) {
    const wanted = expectedSlot(expect.appointment, now)
    const got = appointmentAt ? slotOf(appointmentAt) : null
    add('appointment', got === wanted, `expected ${wanted} (Cairo), recorded ${got ?? 'none'}`)
  }
  if (expect.appointment_hour_in) {
    const hour = appointmentAt ? Number(cairoParts(appointmentAt).time.slice(0, 2)) : null
    add(
      `appointment_hour_in [${expect.appointment_hour_in.join(', ')}]`,
      hour !== null && expect.appointment_hour_in.includes(hour),
      appointmentAt ? `recorded ${slotOf(appointmentAt)}` : 'none recorded'
    )
  }
  if (expect.must_not_claim_booking) {
    // The fact first: what became of the booking, the outcome renderReply was
    // given. This case is one where nothing may be booked, so every turn's
    // outcome has to be none or ask_period.
    const booked = records.findIndex((r) => r.booking.status === 'booked' || r.booking.status === 'kept')
    // Then the wording, on what the visitor is sent after nothing was booked
    const worded = records.findIndex((r) => bookingClaimIn(r.reply).length > 0)
    add(
      'must_not_claim_booking',
      booked < 0 && worded < 0,
      booked >= 0
        ? `outcome "${records[booked].booking.status}" on turn ${booked + 1}: a booking in a case that must have none`
        : worded >= 0
          ? `nothing booked, but reply ${worded + 1} words it as one (${bookingClaimIn(records[worded].reply).join(', ')}): ${records[worded].reply}`
          : `outcomes ${records.map((r) => r.booking.status).join(', ')}; no booking wording`,
      true
    )
  }
  if (expect.phone_on_record !== undefined) {
    const stored = conversation.record.phone
    add('phone_on_record', stored === expect.phone_on_record, `expected ${expect.phone_on_record ?? 'none'}, the lead would hold ${stored ?? 'none'}`)
  }
  if (expect.name_incomplete !== undefined) {
    const { name, nameIncomplete } = conversation.contact
    add(
      'name_incomplete',
      name !== null && nameIncomplete === expect.name_incomplete,
      name === null ? 'no name was accepted at all' : `name "${name}" ${nameIncomplete ? 'flagged incomplete' : 'not flagged'}`
    )
  }
  if (expect.no_cjk) {
    const found = replies.findIndex((reply) => CJK.test(reply))
    add('no_cjk', found < 0, found < 0 ? 'no CJK script in any reply' : `reply ${found + 1} holds CJK script: ${replies[found]}`)
  }
  if (expect.redirects) {
    const redirects = BACK_TO_BUSINESS.test(last)
    add('redirects', redirects, redirects ? 'the last reply points back to the business' : `the last reply does not point back to the business: ${last}`)
  }

  if (expect.lead) {
    const failures: string[] = []
    if (!lead?.recorded) failures.push('no lead would be recorded')
    if (expect.lead.name && !(lead?.name ?? '').replace(/\s+/g, ' ').includes(expect.lead.name)) {
      failures.push(`name "${lead?.name ?? null}", expected "${expect.lead.name}"`)
    }
    if (expect.lead.phone_contains && !(lead?.phone ?? '').includes(expect.lead.phone_contains)) {
      failures.push(`phone "${lead?.phone ?? null}", expected to contain ${expect.lead.phone_contains}`)
    }
    if (expect.lead.service_contains && !expect.lead.service_contains.some((s) => (lead?.service_requested ?? '').includes(s))) {
      failures.push(`service "${lead?.service_requested ?? null}", expected one of ${expect.lead.service_contains.join(' | ')}`)
    }
    add('lead', failures.length === 0, failures.join('; ') || 'fields as expected')
  }
  if (expect.defers_to_team) {
    const defers = DEFERS_TO_TEAM.test(text)
    add('defers_to_team', defers, defers ? `${scope} refers to the team` : `${scope} does not refer to the team`)
  }
  if (expect.emergency_number) {
    const found = text.replace(/[\s\-–]/g, '').includes(EMERGENCY_NUMBER)
    add('emergency_number', found, found ? `${EMERGENCY_NUMBER} appears` : `${EMERGENCY_NUMBER} does not appear`)
  }
  if (expect.no_invented_price) {
    const invented = pricesIn(text).filter((price) => !bot.kbNumbers.has(price))
    add(
      'no_invented_price',
      invented.length === 0,
      invented.length === 0 ? 'no amount outside the knowledge base' : `not in the knowledge base: ${invented.join(', ')}`,
      true
    )
  }
  return results
}

// ---------------------------------------------------------------------------
// ai_usage: what the run's calls really cost
// ---------------------------------------------------------------------------

const seenUsage = new Set<string>()

/** The newest ai_usage row's time, by the database's clock: this script's rows come after it */
async function usageWatermark(admin: Admin, clientId: string) {
  const { data, error } = await admin
    .from('ai_usage')
    .select('created_at')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ created_at: string }>()
  if (error) throw new Error(`reading ai_usage: ${error.message}`)
  return data?.created_at ?? '1970-01-01T00:00:00Z'
}

/**
 * The rows the run just logged. recordAiUsage isn't awaited by the calls it
 * describes, so this waits for the `expected` rows. Runs are sequential and
 * the rows have no conversation, which is what tells them from a visitor's.
 */
async function collectUsage(admin: Admin, clientId: string, since: string, expected: number) {
  const deadline = Date.now() + USAGE_WAIT_MS
  for (;;) {
    const { data, error } = await admin
      .from('ai_usage')
      .select('id, operation, model, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd')
      .eq('client_id', clientId)
      .is('conversation_id', null)
      .in('operation', ['playground', 'embedding', 'lead_analysis'])
      .gt('created_at', since)
      .order('created_at', { ascending: true })
      .limit(2000)
      .returns<UsageRow[]>()
    if (error) throw new Error(`reading ai_usage: ${error.message}`)
    const rows = data.filter((row) => !seenUsage.has(row.id))
    if (rows.length >= expected || Date.now() > deadline) {
      for (const row of rows) seenUsage.add(row.id)
      return {
        rows,
        // Fewer: a call failed before it was billed, or its log was late. More: someone else's playground
        complete: rows.length === expected,
        expectedRows: expected,
        totalTokens: rows.reduce((sum, row) => sum + row.total_tokens, 0),
        costUsd: rows.reduce((sum, row) => sum + Number(row.estimated_cost_usd ?? 0), 0),
        unpriced: rows.filter((row) => row.estimated_cost_usd === null).length,
      }
    }
    await sleep(400)
  }
}

// ---------------------------------------------------------------------------

/**
 * Which system prompt a run was measured on. The demo bot's prompt is edited
 * in the dashboard, so two runs can differ by nothing but this: on 13 October
 * 2026 it was saved between two runs of the frozen set, and their scores
 * (30/36 and 27/36) could not be compared.
 */
function fingerprint(systemPrompt: string) {
  return { sha256: createHash('sha256').update(systemPrompt).digest('hex').slice(0, 12), chars: systemPrompt.length }
}

async function promptSavedAt(admin: Admin, clientId: string) {
  const { data } = await admin.from('bot_settings').select('updated_at').eq('client_id', clientId).maybeSingle<{ updated_at: string }>()
  return data?.updated_at ?? null
}

async function runOnce(bot: Bot, testCase: Case, since: string) {
  const now = new Date()
  let error: string | null = null
  let records: TurnRecord[] = []
  let appointmentAt: string | null = null
  let lead: Awaited<ReturnType<typeof leadFrom>> | null = null
  let assertions: Assertion[] = []
  // One embedding and one reply per turn, one analysis when the lead is checked
  let expectedRows = testCase.turns.length * 2 + (testCase.expect.lead ? 1 : 0)

  for (let attempt = 0; ; attempt += 1) {
    try {
      const conversation = await converse(bot, testCase.turns)
      records = conversation.records
      appointmentAt = conversation.appointmentAt
      if (testCase.expect.lead) lead = await leadFrom(bot, conversation)
      assertions = check(testCase, records, appointmentAt, lead, bot, now, conversation)
      // Without the knowledge base the reply isn't the provider's doing
      if (records.some((r) => r.retrievalError)) error = 'knowledge retrieval failed'
      break
    } catch (caught) {
      // A daily quota doesn't come back by waiting: every run after this one
      // would fail the same way and be scored as the provider's
      if (aiFailureReason(caught) === 'rate_limited' && /PerDay/.test(String((caught as Error).message))) {
        throw new Error(`the provider's daily quota is used up; nothing was scored for ${testCase.id} onwards`, { cause: caught })
      }
      if (aiFailureReason(caught) === 'rate_limited' && attempt < RATE_LIMIT_WAITS_MS.length) {
        console.warn(`  ${testCase.id}: rate limited (429), waiting ${RATE_LIMIT_WAITS_MS[attempt] / 1000}s`)
        await sleep(RATE_LIMIT_WAITS_MS[attempt])
        // What the abandoned attempt logged stays with this run
        expectedRows = -1
        continue
      }
      error = caught instanceof Error ? caught.message : String(caught)
      expectedRows = -1
      break
    }
  }

  const usage = await collectUsage(bot.admin, bot.clientId, since, Math.max(expectedRows, 0))
  if (expectedRows < 0) usage.complete = false
  return {
    passed: error === null && assertions.every((a) => a.passed),
    error,
    turns: records,
    appointment: appointmentAt ? { at: appointmentAt, cairo: slotOf(appointmentAt) } : null,
    lead,
    assertions,
    usage,
  }
}

async function main() {
  const provider = arg('provider')
  if (!provider) throw new Error('usage: npm run eval -- --provider=gemini|openai')
  process.env.AI_PROVIDER = provider
  // Throws here, before any call, when the provider isn't one the app has
  const model = replyModel()
  if (provider === 'gemini' && model !== GEMINI_BASELINE_MODEL) {
    throw new Error(`GOOGLE_GEMINI_MODEL is "${model}": the baseline is run on ${GEMINI_BASELINE_MODEL}, the model production uses`)
  }

  const repeats = Number(arg('repeats') ?? 3)
  const only = arg('only')?.split(',')
  // The frozen set, or a named one of its own: eval/cases-<name>.json
  const set = arg('cases')
  if (set && !/^[a-z0-9-]+$/.test(set)) throw new Error(`--cases=${set}: a set is named in lowercase letters, digits and dashes`)
  const casesFile = set ? `cases-${set}.json` : 'cases.json'
  const { cases: allCases } = JSON.parse(readFileSync(path.join(EVAL_DIR, casesFile), 'utf8')) as { cases: Case[] }
  const cases = only ? allCases.filter((c) => only.includes(c.id)) : allCases

  const admin = createAdminClient()
  const demo = await findDemo(admin)
  if (!demo) throw new Error('the demo account does not exist: run `npm run seed:demo` first')
  const { data: client, error: clientError } = await admin
    .from('clients')
    .select('name, industry, description')
    .eq('id', demo.clientId)
    .single<BotClient>()
  if (clientError) throw new Error(`loading the demo client: ${clientError.message}`)
  const settings = await loadBotSettings(admin, demo.clientId)
  if (settings.temperature !== PRODUCTION_TEMPERATURE) {
    throw new Error(`the demo bot's temperature is ${settings.temperature}, not ${PRODUCTION_TEMPERATURE}: this would not measure production`)
  }
  const { count: chunks } = await admin
    .from('knowledge_documents')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', demo.clientId)
    .not('source_document_id', 'is', null)

  const bot: Bot = { admin, clientId: demo.clientId, client, settings, kbNumbers: knowledgeBaseNumbers() }
  const startedAt = new Date()
  const since = await usageWatermark(admin, demo.clientId)
  // The run uses the settings loaded above; the fingerprint says which prompt that was
  const prompt = { ...fingerprint(settings.system_prompt), savedAt: await promptSavedAt(admin, demo.clientId) }
  console.log(
    `provider ${provider} · model ${model} · temperature ${settings.temperature} · eval/${casesFile}: ${cases.length} cases × ${repeats}\n` +
      `database ${new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host} · demo client ${demo.clientId} · ${chunks ?? '?'} knowledge chunks\n` +
      `system prompt ${prompt.sha256} · ${prompt.chars} chars · saved ${prompt.savedAt ?? '?'}\n`
  )

  const results = []
  for (const testCase of cases) {
    const runs = []
    for (let i = 0; i < repeats; i += 1) runs.push(await runOnce(bot, testCase, since))
    const passed = runs.filter((run) => run.passed).length
    const errors = runs.filter((run) => run.error).length
    results.push({
      id: testCase.id,
      group: testCase.group,
      turns: testCase.turns,
      search: testCase.search ?? 'last',
      expect: testCase.expect,
      passed,
      runs,
    })
    const failed = [...new Set(runs.flatMap((run) => run.assertions.filter((a) => !a.passed).map((a) => a.name)))]
    console.log(
      `${testCase.id.padEnd(5)} ${testCase.group.padEnd(18)} ${passed}/${repeats}` +
        (errors ? `  ERR×${errors}` : '') +
        (failed.length ? `  ✗ ${failed.join(' · ')}` : '')
    )
  }

  const critical = results.flatMap((result) =>
    result.runs.flatMap((run, i) =>
      run.assertions.filter((a) => a.critical).map((a) => ({ case: result.id, run: i + 1, assertion: a.name, detail: a.detail }))
    )
  )
  const allRuns = results.flatMap((result) => result.runs)
  // Edited in the dashboard while the run was in flight: the run itself kept
  // the prompt it started with, but whoever compares it should know
  const promptNow = fingerprint((await loadBotSettings(admin, demo.clientId)).system_prompt)
  const summary = {
    provider,
    model,
    set: casesFile,
    temperature: settings.temperature,
    // Two runs are comparable only when this is the same in both (RUNNER.md)
    prompt: { ...prompt, editedDuringRun: promptNow.sha256 !== prompt.sha256 },
    knowledgeChunks: chunks ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    repeats,
    cases: results.length,
    passed: results.filter((result) => result.passed === repeats).length,
    partial: results.filter((result) => result.passed > 0 && result.passed < repeats).map((result) => result.id),
    failed: results.filter((result) => result.passed === 0).map((result) => result.id),
    errors: allRuns.filter((run) => run.error).length,
    critical,
    verdict: critical.length > 0 ? 'rejected' : 'no critical failure',
    usage: {
      rows: allRuns.reduce((sum, run) => sum + run.usage.rows.length, 0),
      totalTokens: allRuns.reduce((sum, run) => sum + run.usage.totalTokens, 0),
      costUsd: Number(allRuns.reduce((sum, run) => sum + run.usage.costUsd, 0).toFixed(6)),
      unpricedRows: allRuns.reduce((sum, run) => sum + run.usage.unpriced, 0),
      runsWithIncompleteUsage: allRuns.filter((run) => !run.usage.complete).length,
    },
  }

  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const file = path.join(EVAL_DIR, `eval-results-${provider}-${set ? `${set}-` : ''}${stamp}.json`)
  writeFileSync(file, JSON.stringify({ note: RESULTS_NOTE, summary, results }, null, 2))

  for (const c of critical) console.log(`CRITICAL ${c.case} run ${c.run}: ${c.assertion} — ${c.detail}`)
  if (summary.prompt.editedDuringRun) {
    console.log(`the demo bot's system prompt was edited during the run (now ${promptNow.sha256}): later runs are not comparable to this one`)
  }
  if (summary.usage.unpricedRows) console.log(`${summary.usage.unpricedRows} ai_usage rows have no price: the cost below is too low`)
  if (summary.usage.runsWithIncompleteUsage) {
    console.log(`${summary.usage.runsWithIncompleteUsage} runs did not log the ai_usage rows expected of them`)
  }
  console.log(`\n${path.relative(ROOT, file)}`)
  console.log(
    `${provider} on eval/${casesFile}: ${summary.passed}/${summary.cases} cases passed ${repeats}/${repeats} · ${summary.verdict}` +
      ` · ${summary.usage.totalTokens} tokens · $${summary.usage.costUsd.toFixed(4)} (ai_usage)`
  )
}

if (process.argv[1]?.endsWith('eval.ts')) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
