import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { expect, onTestFailed } from 'vitest'
import { POST } from '../../app/api/webhook/website/[channelId]/route'
import { flushAfter, geminiText, seedClient, serviceClient, type GeminiCall } from '../harness/helpers'

export const newVisitorId = () => `visitor-${randomUUID()}`

/** Posts a visitor message to the real webhook and waits for its after() work */
export async function sendVisitorMessage(
  channelId: string,
  message: string,
  visitor: { visitorId?: string; conversationId?: string } = {}
) {
  const request = new NextRequest(`http://localhost/api/webhook/website/${channelId}`, {
    method: 'POST',
    // A fresh address per call keeps the route's rate limiter out of the way
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': randomUUID() },
    body: JSON.stringify({ message, visitorId: visitor.visitorId ?? newVisitorId(), conversationId: visitor.conversationId }),
  })
  const response = await POST(request, { params: Promise.resolve({ channelId }) })
  // Lead detection is scheduled with after(): let it finish before asserting
  await flushAfter()
  const body = (await response.json()) as Record<string, unknown>
  if (typeof body.conversationId === 'string') dumpOnFailure(body.conversationId)
  return { status: response.status, body }
}

// The conversations the running test has written to; one failure hook per test
let watchedTest: string | undefined
let watched = new Set<string>()

/**
 * When a webhook test fails, its conversations' rows are printed as the
 * webhook and lead detection read them: ordered by created_at alone, with
 * every created_at as stored, and a row that shares its created_at with
 * another marked TIE. Evidence for the ordering defect (AGENTS.md: rows read
 * in the wrong order) — whether the rows that came back out of order share a
 * timestamp. It prints on any failure, since the ordering ones can't be told
 * apart in advance; npm run check keeps the output of a failed run.
 */
function dumpOnFailure(conversationId: string) {
  const test = expect.getState().currentTestName
  if (!test) return
  if (test !== watchedTest) {
    watchedTest = test
    watched = new Set()
    const ids = watched
    onTestFailed(async () => {
      const supabase = serviceClient()
      for (const id of ids) {
        const [messages, leads] = await Promise.all([
          supabase.from('messages').select('id, role, created_at, content').eq('conversation_id', id).order('created_at', { ascending: true }),
          supabase.from('leads').select('id, status, created_at, updated_at').eq('conversation_id', id).order('created_at', { ascending: true }),
        ])
        const tie = (rows: { created_at: string }[] | null) =>
          (row: { created_at: string }) => ((rows ?? []).filter((other) => other.created_at === row.created_at).length > 1 ? ' TIE' : '')
        const markMessage = tie(messages.data)
        const markLead = tie(leads.data)
        console.error(
          [
            `[ordering dump] ${test} — conversation ${id}, rows ordered by created_at as the app orders them`,
            ...(messages.error ? [`  messages: error ${messages.error.message}`] : (messages.data ?? []).map((m) => `  message ${m.created_at}${markMessage(m)} ${m.role} ${m.id} ${JSON.stringify(String(m.content).slice(0, 60))}`)),
            ...(leads.error ? [`  leads: error ${leads.error.message}`] : (leads.data ?? []).map((l) => `  lead ${l.created_at}${markLead(l)} ${l.status} ${l.id} updated ${l.updated_at}`)),
          ].join('\n')
        )
      }
    })
  }
  watched.add(conversationId)
}

export const INTRO_MESSAGE = 'السلام عليكم، أنا كريم مصطفى، عايز أحجز تنظيف أسنان. رقمي 01012345678'

/**
 * Stands in for the analysis model: like the real one, it judges whatever
 * transcript it is given. Buying intent = a visitor line that asks to book
 * ("أحجز"); the name and phone are picked up only if the visitor wrote them.
 */
export function analyseTranscript(call: GeminiCall) {
  const prompt = (call.body.contents as { parts: { text: string }[] }[])[0].parts[0].text
  const visitor = prompt
    .split('\n')
    .filter((line) => line.startsWith('Visitor: '))
    .join('\n')
  const intent = visitor.includes('أحجز')
  // Asked only about messages the bot didn't answer (the schema then has "appointment")
  const schema = (call.body.generationConfig as { responseSchema: { properties: Record<string, unknown> } }).responseSchema
  const appointment = !('appointment' in schema.properties)
    ? {}
    : visitor.includes('الخميس الساعة 6 المغرب')
      ? { appointment: { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' } }
      : { appointment: null }
  return {
    ...appointment,
    is_lead: intent,
    confidence: intent ? 0.9 : 0.1,
    name: visitor.includes('كريم مصطفى') ? 'كريم مصطفى' : null,
    phone: visitor.match(/01\d{9}/)?.[0] ?? null,
    service_requested: visitor.includes('تبييض') ? 'تبييض أسنان' : intent ? 'تنظيف أسنان' : null,
  }
}

/** The visitor's latest message, as the chat model received it */
export function lastVisitorMessage(call: GeminiCall) {
  const turns = call.body.contents as { role: string; parts: { text: string }[] }[]
  return turns.findLast((turn) => turn.role === 'user')?.parts[0].text ?? ''
}

/**
 * What the stand-in chat model reports as the visitor's own details, whatever
 * the message: the name these tests' visitor uses. The real model reports
 * what the latest message gave; the app keeps a reported name only if the
 * visitor wrote it (readContact), so in a conversation where they never did,
 * this is dropped — which is the rule under test, not a shortcut around it.
 */
export const REPORTED_CONTACT = { name: 'كريم مصطفى', phone: null }

/** The chat model's structured answer: the details and appointment components it read, and its text */
export const botReply = (
  reply: string,
  appointment: Record<string, unknown> | null = null,
  contact: { name?: string | null; phone?: string | null } | null = REPORTED_CONTACT,
  /** Its answer to something else the same message asked: the only text of its own sent with an appointment */
  otherAnswer: string | null = null
) => geminiText(JSON.stringify({ contact, appointment, other_answer: otherAnswer, reply }))

/**
 * Opening hours on the client's branch (the one every client starts with):
 * the assistant only confirms a time it could check against them. Only the
 * branch's: the bot settings' own hours no longer decide a booking.
 */
export async function openEveryDay(
  seeded: Pick<Awaited<ReturnType<typeof seedClient>>, 'supabase' | 'clientId'>,
  from = '08:00',
  to = '23:00'
) {
  await setBranchHours(seeded, Object.fromEntries(WEEK.map((day) => [day, [[from, to]]])))
}

const WEEK = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const

/** Every branch of the client, oldest first: the default one, then any a test added */
export async function clientBranches(seeded: Pick<Awaited<ReturnType<typeof seedClient>>, 'supabase' | 'clientId'>) {
  const { data, error } = await seeded.supabase
    .from('branches')
    .select('id, name')
    .eq('client_id', seeded.clientId)
    .order('created_at', { ascending: true })
    .returns<{ id: string; name: string }[]>()
  if (error) throw new Error(`Reading the branches failed: ${error.message}`)
  return data
}

/** The hours of one branch (the client's first when none is named), as the branch form writes them */
export async function setBranchHours(
  seeded: Pick<Awaited<ReturnType<typeof seedClient>>, 'supabase' | 'clientId'>,
  hours: Partial<Record<(typeof WEEK)[number], [string, string][]>>,
  branchId?: string
) {
  const id = branchId ?? (await clientBranches(seeded))[0].id
  const business_hours = Object.fromEntries(WEEK.map((day) => [day, hours[day] ?? []]))
  const { error } = await seeded.supabase.from('branches').update({ business_hours }).eq('id', id)
  if (error) throw new Error(`Setting the opening hours failed: ${error.message}`)
}

/** A second (third…) branch for the client, with its hours */
export async function addBranch(
  seeded: Pick<Awaited<ReturnType<typeof seedClient>>, 'supabase' | 'clientId'>,
  name: string,
  hours: Partial<Record<(typeof WEEK)[number], [string, string][]>> | null
) {
  const business_hours = hours && Object.fromEntries(WEEK.map((day) => [day, hours[day] ?? []]))
  const { data, error } = await seeded.supabase
    .from('branches')
    .insert({ client_id: seeded.clientId, name, business_hours })
    .select('id')
    .single<{ id: string }>()
  if (error) throw new Error(`Adding the branch failed: ${error.message}`)
  return data.id
}

/**
 * The chat model answers (reporting "بكرة الساعة 5 العصر" as tomorrow, hour
 * 5, afternoon, the way the real one is asked to), the analysis model reads
 * the transcript
 */
export function geminiWorks(call: GeminiCall) {
  if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
  if (call.kind === 'analysis') return geminiText(JSON.stringify(analyseTranscript(call)))
  return lastVisitorMessage(call).includes('بكرة الساعة 5 العصر')
    ? botReply('تمام، حجزتلك {{appointment}}', { day_type: 'tomorrow', hour: 5, period: 'afternoon' })
    : botReply('أهلاً بيك، تحت أمرك')
}

export type LeadSnapshot = {
  id: string
  name: string | null
  phone: string | null
  service_requested: string | null
  status: string
  appointment_at: string | null
  appointment_confirmed: boolean
  showed_up: boolean | null
  arrival_confirmed_at: string | null
  ai_extracted_data: Record<string, unknown> | null
  updated_at: string
}

/** A lead row as dumpLeadsOnFailure prints it */
type LeadTrace = { id: string; conversation_id: string; status: string; created_at: string; updated_at: string }

const LEAD_SNAPSHOT =
  'id, name, phone, service_requested, status, appointment_at, appointment_confirmed, showed_up, arrival_confirmed_at, ai_extracted_data, updated_at'

/**
 * A client whose visitor has introduced themselves and asked to book: one
 * conversation with lead #1 open. Needs mockGemini(geminiWorks) first.
 */
export async function startConversation() {
  const seeded = await seedClient()
  const visitorId = newVisitorId()
  const { body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE, { visitorId })
  const conversationId = body.conversationId as string

  const readTrace = () =>
    seeded.supabase
      .from('leads')
      .select(`${LEAD_SNAPSHOT}, conversation_id, created_at`)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .returns<(LeadSnapshot & { conversation_id: string; created_at: string })[]>()
  const trace = ({ id, conversation_id, status, created_at, updated_at }: LeadTrace): LeadTrace => ({
    id,
    conversation_id,
    status,
    created_at,
    updated_at,
  })

  // What the last leads() call got back, kept for dumpLeadsOnFailure
  let lastRead: LeadTrace[] = []
  const leads = async (): Promise<LeadSnapshot[]> => {
    const { data, error } = await readTrace()
    if (error) throw new Error(error.message)
    lastRead = data.map(trace)
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    return data.map(({ conversation_id, created_at, ...snapshot }) => snapshot)
  }

  /**
   * Runs the assertions, and when one fails prints the lead rows before
   * rethrowing: the rows the last leads() call returned, in the order it
   * returned them, the same query read again, and the ids the test captured
   * as the leads were created. Prints nothing when the assertions pass.
   *
   * Here for a failure seen once in a full run and not since (lead #2 came
   * back ahead of lead #1 in "leaves lead #1's appointment and attendance
   * untouched"): it records what was returned, it does not change the order.
   */
  const dumpLeadsOnFailure = async (captured: Record<string, string | undefined>, assertions: () => void | Promise<void>) => {
    const returned = lastRead
    try {
      await assertions()
    } catch (failure) {
      const again = await readTrace()
      console.error(
        '[lead dump] the assertions failed\n' +
          JSON.stringify(
            {
              conversationId,
              captured,
              returned,
              readAgain: again.error ? `error: ${again.error.message}` : again.data.map(trace),
              readAgainAt: new Date().toISOString(),
            },
            null,
            2
          )
      )
      throw failure
    }
  }
  const send = (message: string) => sendVisitorMessage(seeded.channelId, message, { visitorId, conversationId })

  /** The team books the first visit two days ago and marks it attended */
  const attendFirstVisit = async () => {
    const [first] = await leads()
    const appointment_at = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const booked = await seeded.supabase.from('leads').update({ appointment_at, status: 'appointment_booked' }).eq('id', first.id)
    const attended = await seeded.supabase.from('leads').update({ status: 'showed_up' }).eq('id', first.id)
    if (booked.error || attended.error) throw new Error('Marking the first visit attended failed')
    return (await leads())[0]
  }

  return { ...seeded, visitorId, conversationId, leads, send, attendFirstVisit, dumpLeadsOnFailure }
}
