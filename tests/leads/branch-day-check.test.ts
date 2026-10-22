import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import type { Schedule } from '@/lib/ai/appointment'
import { buildSystemPrompt } from '@/lib/ai/bot'
import { branchInMessage, describeBranches, type BookingBranch } from '@/lib/ai/branches'
import { DEFAULT_BUSINESS_HOURS, type BotSettingsInput } from '@/lib/types/bot-settings'
import { geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { addBranch, analyseTranscript, clientBranches, lastVisitorMessage, newVisitorId, sendVisitorMessage, setBranchHours } from './webhook'

/**
 * THE DAY IS CHECKED AGAINST THE BRANCH (22 October 2026). Dr.Ali's day-only
 * bot booked a closed Friday, Saturday and Tuesday at المنصورة in a row
 * (conversation bc3d7dbb): the model knew the hours and said them, but the
 * code writing the confirmation checked nothing. The branch's hours are now
 * the booking record: a closed day is refused in code's sentence, naming the
 * days it opens; with more than one branch the branch is asked for before a
 * day can be checked; the prompt states the same record.
 */

const T = ar.botReplies.appointment
// Thursday 22 October 2026, 06:20 in Cairo: the morning the three closed days were booked
const NOW = '2026-10-22T03:20:00.000Z'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
})

// Dr.Ali's two branches as Ahmed entered them on 22 October
const MANSOURA = { sun: [['20:00', '22:00']], mon: [['17:00', '20:00']], wed: [['20:00', '22:00']], thu: [['12:00', '14:00']] } as const
const MANZALA = { sat: [['18:00', '21:00']], sun: [['12:00', '14:00']], tue: [['19:00', '22:00']], wed: [['12:00', '14:00']] } as const
const MANSOURA_OPEN_DAYS = 'الأحد والاثنين والأربعاء والخميس'

type Hours = Parameters<typeof setBranchHours>[1]
const hoursOf = (week: Record<string, readonly (readonly [string, string])[]>) =>
  Object.fromEntries(Object.entries(week).map(([day, ranges]) => [day, ranges.map(([a, b]) => [a, b])])) as Hours

/** The chat model's answer, with the branch it reports */
const reply = (text: string, { appointment = null, branch = null, name = null, phone = null }: { appointment?: Record<string, unknown> | null; branch?: string | null; name?: string | null; phone?: string | null } = {}) =>
  geminiText(
    JSON.stringify({ contact: name || phone ? { name, phone } : null, appointment: appointment && { period: 'unspecified', ...appointment }, branch, other_answer: null, reply: text })
  )

function chatModel(script: Record<string, Response>) {
  mockGemini((call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return geminiText(JSON.stringify(analyseTranscript(call)))
    const answer = script[lastVisitorMessage(call)]
    if (!answer) throw new Error(`The test's chat model has no answer for "${lastVisitorMessage(call)}"`)
    return answer.clone()
  })
}

/** Dr.Ali's setup: day-only, المنصورة (the client's first branch, renamed) and المنزلة */
async function drAli({ branches = 'two' }: { branches?: 'one' | 'two' } = {}) {
  const seeded = await seedClient({ bookingMode: 'day_only' })
  const [first] = await clientBranches(seeded)
  await seeded.supabase.from('branches').update({ name: 'فرع المنصورة' }).eq('id', first.id)
  await setBranchHours(seeded, hoursOf(MANSOURA), first.id)
  const manzala = branches === 'two' ? await addBranch(seeded, 'فرع المنزلة', hoursOf(MANZALA)) : null
  const visitorId = newVisitorId()
  let conversationId: string | undefined
  const say = async (message: string) => {
    const { status, body } = await sendVisitorMessage(seeded.channelId, message, { visitorId, conversationId })
    expect(status).toBe(200)
    conversationId = body.conversationId as string
    return body.reply as string
  }
  const lead = async () => {
    const { data } = await seeded.supabase
      .from('leads')
      .select('appointment_at, ai_appointment, branch_id, branch, booking_draft')
      .eq('client_id', seeded.clientId)
      .returns<{ appointment_at: string | null; ai_appointment: Record<string, unknown> | null; branch_id: string | null; branch: string | null; booking_draft: Record<string, unknown> | null }[]>()
    return data?.[0] ?? null
  }
  const conversation = async () => {
    const { data } = await seeded.supabase.from('conversations').select('needs_human_since').eq('id', conversationId!).single()
    return data as { needs_human_since: string | null }
  }
  return { ...seeded, say, lead, conversation, mansoura: first.id, manzala }
}

describe('a day is checked against the branch it is for', () => {
  // Conversation bc3d7dbb, replayed: each of these was «تمام — حجزك يوم …»
  it('refuses Friday, Saturday and Tuesday at المنصورة in code\'s own sentence, naming the days it opens, and records none of them', async () => {
    chatModel({
      'المنصورة': reply('تحب تيجي أي يوم؟', { branch: 'فرع المنصورة' }),
      'الجمعة': reply('', { appointment: { day_type: 'weekday', weekday: 'friday' } }),
      'السبت': reply('', { appointment: { day_type: 'weekday', weekday: 'saturday' } }),
      'الثلاثاء': reply('', { appointment: { day_type: 'weekday', weekday: 'tuesday' } }),
      'الخميس': reply('', { appointment: { day_type: 'weekday', weekday: 'thursday' } }),
    })
    const { say, lead, mansoura } = await drAli()
    await say('المنصورة')

    const refused = (day: string) => T.closedDayAt.replace('{branch}', 'فرع المنصورة').replace('{day}', day).replace('{openDays}', MANSOURA_OPEN_DAYS)
    expect(await say('الجمعة')).toBe(refused('الجمعة'))
    expect(await say('السبت')).toBe(refused('السبت'))
    expect(await say('الثلاثاء')).toBe(refused('الثلاثاء'))
    expect((await lead())?.ai_appointment ?? null).toBeNull()

    // An open day goes on, checked: «عشان أحجزلك», not the request wording
    const asked = await say('الخميس')
    expect(asked).toBe(T.needDetailsDay.replace('{day}', 'الخميس 22 أكتوبر').replace('{missing}', T.missingNameAny))
    expect(await lead()).toMatchObject({ branch_id: mansoura, branch: 'فرع المنصورة', ai_appointment: { validated: true, day_only: true } })
  })

  // Conversation 815fc0b3: «عايزه احجز التلات» with no branch was booked, and
  // the analysis guessed المنزلة afterwards
  it('holds a day said before the branch, asks which branch naming it, and checks it once the branch is known', async () => {
    chatModel({
      'عايزه احجز الثلاثاء': reply('', { appointment: { day_type: 'weekday', weekday: 'tuesday' } }),
      'المنصورة': reply('تمام', { branch: 'فرع المنصورة' }),
    })
    const { say, lead } = await drAli()

    expect(await say('عايزه احجز الثلاثاء')).toBe(
      T.askBranchForDay.replace('{day}', 'الثلاثاء 27 أكتوبر').replace('{branches}', 'فرع المنصورة أو فرع المنزلة')
    )
    expect((await lead())?.ai_appointment ?? null).toBeNull()
    // Closed there: refused, and only the day goes
    expect(await say('المنصورة')).toBe(
      T.closedDayAt.replace('{branch}', 'فرع المنصورة').replace('{day}', 'الثلاثاء').replace('{openDays}', MANSOURA_OPEN_DAYS)
    )
    expect((await lead())?.booking_draft).toMatchObject({ day: null, branch: 'فرع المنصورة' })
  })

  it('books the held day at the branch that opens on it', async () => {
    chatModel({
      'عايزه احجز الثلاثاء': reply('', { appointment: { day_type: 'weekday', weekday: 'tuesday' } }),
      'المنزلة': reply('تمام', { branch: 'فرع المنزلة' }),
    })
    const { say, lead, manzala } = await drAli()
    await say('عايزه احجز الثلاثاء')

    expect(await say('المنزلة')).toBe(T.needDetailsDay.replace('{day}', 'الثلاثاء 27 أكتوبر').replace('{missing}', T.missingNameAny))
    expect(await lead()).toMatchObject({ branch_id: manzala, ai_appointment: { validated: true, pending: true } })
  })

  it('never asks a client with one branch which branch: it is the branch', async () => {
    chatModel({ 'عايز أحجز الجمعة': reply('', { appointment: { day_type: 'weekday', weekday: 'friday' } }) })
    const { say } = await drAli({ branches: 'one' })
    // Refused without naming the branch: there is no other to tell it from
    expect(await say('عايز أحجز الجمعة')).toBe(T.closedDay.replace('{day}', 'الجمعة').replace('{openDays}', MANSOURA_OPEN_DAYS))
  })

  it('refuses a date the branch has closed, by its date', async () => {
    chatModel({ 'عايز أحجز الأحد': reply('', { appointment: { day_type: 'weekday', weekday: 'sunday' } }) })
    const { say, supabase, clientId, mansoura } = await drAli({ branches: 'one' })
    await supabase.from('branch_closures').insert({ client_id: clientId, branch_id: mansoura, date: '2026-10-25', reason: 'إجازة' })

    expect(await say('عايز أحجز الأحد')).toBe(T.closureDay.replace('{date}', 'الأحد 25 أكتوبر'))
  })

  it('hands a branch whose hours open on no day to a person, and says so, rather than inventing a rule', async () => {
    chatModel({ 'عايز أحجز الخميس': reply('', { appointment: { day_type: 'weekday', weekday: 'thursday' } }) })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seeded = await drAli({ branches: 'one' })
    await setBranchHours(seeded, {}, seeded.mansoura)

    expect(await seeded.say('عايز أحجز الخميس')).toBe(T.noOpenDays)
    expect((await seeded.conversation()).needs_human_since).not.toBeNull()
    expect(errors.mock.calls.some(([line]) => String(line).includes('open on no day'))).toBe(true)
    errors.mockRestore()
  })
})

describe('which branch a message chose', () => {
  const branch = (name: string): BookingBranch => ({ id: name, name, schedule: null })
  const both = [branch('فرع المنصورة'), branch('فرع المنزلة')]

  it('is the one the visitor\'s own words name, as people type it', () => {
    expect(branchInMessage(both, 'المنصورة', null)?.name).toBe('فرع المنصورة')
    expect(branchInMessage(both, 'فرع المنزله لو سمحت', null)?.name).toBe('فرع المنزلة')
  })

  it('is none when the message names none, whatever the model reported', () => {
    expect(branchInMessage(both, 'عايز أحجز', 'فرع المنصورة')).toBeNull()
  })

  it('takes the model\'s report only to choose between branches the message names', () => {
    expect(branchInMessage(both, 'المنصورة ولا المنزلة؟', null)).toBeNull()
    expect(branchInMessage(both, 'المنصورة ولا المنزلة؟ خليها المنزلة', 'فرع المنزلة')?.name).toBe('فرع المنزلة')
  })
})

describe('the prompt states the branches\' hours, the record the booking is checked against', () => {
  const schedule = (week: Record<string, readonly (readonly [string, string])[]>, closures: string[] = []): Schedule => ({
    days: { sat: [], sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], ...hoursOf(week) } as Schedule['days'],
    closures,
  })
  const branches: BookingBranch[] = [
    { id: 'm', name: 'فرع المنصورة', schedule: schedule(MANSOURA, ['2026-10-30']) },
    { id: 'z', name: 'فرع المنزلة', schedule: schedule(MANZALA) },
  ]

  it('lists each branch\'s week and its closures, and says to answer from them, never from the knowledge base', () => {
    const block = describeBranches(branches, new Date(NOW))
    expect(block).toContain('- فرع المنصورة: Sun 20:00–22:00; Mon 17:00–20:00; Wed 20:00–22:00; Thu 12:00–14:00. Closed Sat, Tue, Fri.')
    expect(block).toContain('- فرع المنزلة: Sat 18:00–21:00; Sun 12:00–14:00; Tue 19:00–22:00; Wed 12:00–14:00. Closed Mon, Thu, Fri.')
    expect(block).toContain('Closed on these dates: فرع المنصورة 2026-10-30.')
    expect(block).toContain('never from the knowledge base')
    expect(block).toContain('"branch"')
  })

  it('replaces the bot settings\' own hours in the prompt: one schedule stated, the one booked from', () => {
    const settings: BotSettingsInput = {
      system_prompt: 'x',
      tone: 'friendly',
      language: 'ar',
      temperature: 0.3,
      max_response_length: 500,
      welcome_message: 'x',
      fallback_message: 'x',
      service_unavailable_message: 'x',
      auto_confirm_appointments: true,
      business_hours: { ...DEFAULT_BUSINESS_HOURS, enabled: true },
      booking_mode: 'day_only',
      name_strictness: 'single',
    }
    const prompt = buildSystemPrompt({ name: 'Dr.Ali', industry: null, description: null }, settings, [], new Date(NOW), null, false, branches)
    expect(prompt).toContain('فرع المنصورة: Sun 20:00–22:00')
    // The settings' 09:00–17:00 week is not stated anywhere
    expect(prompt).not.toContain('09:00')
  })

  it('states nothing when no branch has hours: the knowledge base is all there is, as before', () => {
    expect(describeBranches([{ id: 'm', name: 'الفرع الرئيسي', schedule: null }], new Date(NOW))).toBe('')
  })
})
