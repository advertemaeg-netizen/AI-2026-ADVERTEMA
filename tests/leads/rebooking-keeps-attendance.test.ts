import { expect, it, vi } from 'vitest'
import { setAppointment } from '@/lib/actions/appointments'
import { interceptRest, seedClient, serviceClient, uniqueViolation } from '../harness/helpers'

// The team's server action, signed in as someone who can see the lead
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ supabase: serviceClient(), profile: { id: 'team-member' } }),
  isImpersonating: async () => false,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const VISIT = 'id, client_id, name, phone, status, conversation_id, appointment_at, appointment_confirmed, showed_up, arrival_confirmed_at'
type Visit = {
  id: string
  client_id: string
  name: string | null
  phone: string | null
  status: string
  conversation_id: string | null
  appointment_at: string | null
  appointment_confirmed: boolean
  showed_up: boolean | null
  arrival_confirmed_at: string | null
}

const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
const sameTime = (a: string | null, b: string) => a !== null && new Date(a).getTime() === new Date(b).getTime()

/** A lead on a conversation whose first visit, two days ago, was attended */
async function attendedLead() {
  const { supabase, clientId, channelId } = await seedClient()
  const { data: conversation } = await supabase
    .from('conversations')
    .insert({ client_id: clientId, channel_id: channelId, contact_identifier: 'visitor-rebooking', status: 'new' })
    .select('id')
    .single<{ id: string }>()
  const { data: lead } = await supabase
    .from('leads')
    .insert({
      client_id: clientId,
      conversation_id: conversation!.id,
      name: 'كريم مصطفى',
      phone: '01012345678',
      status: 'appointment_booked',
      appointment_at: daysFromNow(-2),
    })
    .select('id')
    .single<{ id: string }>()
  await supabase.from('leads').update({ status: 'showed_up' }).eq('id', lead!.id)

  const visits = async () =>
    (
      await supabase
        .from('leads')
        .select(VISIT)
        .eq('conversation_id', conversation!.id)
        .order('created_at', { ascending: true })
        .returns<Visit[]>()
    ).data!
  const [attended] = await visits()
  expect(attended).toMatchObject({ status: 'showed_up', showed_up: true })
  expect(attended.arrival_confirmed_at).not.toBeNull()
  return { supabase, attended, visits }
}

it('opens a new lead when the team books an appointment for a lead that attended, leaving the visit as it was', async () => {
  const { attended, visits } = await attendedLead()
  const nextVisit = daysFromNow(7)

  const result = await setAppointment(attended.id, nextVisit)

  const [first, second, ...rest] = await visits()
  expect(rest).toEqual([])
  // The attended visit: same time, same attendance, same status
  expect(first).toEqual(attended)
  // The new visit: same contact, booked, nothing recorded yet
  expect(result).toEqual({ ok: true, leadId: second.id })
  expect(second).toMatchObject({
    name: 'كريم مصطفى',
    phone: '01012345678',
    conversation_id: attended.conversation_id,
    status: 'appointment_booked',
    appointment_confirmed: false,
    showed_up: null,
    arrival_confirmed_at: null,
  })
  expect(sameTime(second.appointment_at, nextVisit)).toBe(true)

  // Moving that booking is an ordinary update of the open lead: no third lead
  expect(await setAppointment(second.id, daysFromNow(8))).toEqual({ ok: true })
  expect(await visits()).toHaveLength(2)
})

it('books on the open lead when the conversation already has one and the new lead is refused with 23505', async () => {
  const { supabase, attended, visits } = await attendedLead()
  // The customer came back on their own: the AI already opened lead #2
  const { error } = await supabase
    .from('leads')
    .insert({ client_id: attended.client_id, conversation_id: attended.conversation_id, name: 'كريم مصطفى', status: 'new' })
  expect(error).toBeNull()
  const nextVisit = daysFromNow(7)
  // What the database answers to a second open lead (see one-open-lead-index.test.ts)
  interceptRest({ path: '/leads', method: 'POST' }, () => uniqueViolation('one_open_lead_per_conversation'))

  const result = await setAppointment(attended.id, nextVisit)

  const [first, second, ...rest] = await visits()
  expect(rest).toEqual([])
  expect(first).toEqual(attended)
  expect(result).toEqual({ ok: true, leadId: second.id })
  expect(second).toMatchObject({ status: 'appointment_booked', showed_up: null })
  expect(sameTime(second.appointment_at, nextVisit)).toBe(true)
})

it('keeps showed_up and arrival_confirmed_at when an attended lead gets a new appointment time directly', async () => {
  const { supabase, attended, visits } = await attendedLead()
  const nextVisit = daysFromNow(7)

  // Not through the team action: the database itself must not erase the visit
  const { error } = await supabase.from('leads').update({ appointment_at: nextVisit }).eq('id', attended.id)
  expect(error).toBeNull()

  const [rebooked] = await visits()
  expect(sameTime(rebooked.appointment_at, nextVisit)).toBe(true)
  expect(rebooked.showed_up).toBe(true)
  expect(rebooked.arrival_confirmed_at).toBe(attended.arrival_confirmed_at)
})
