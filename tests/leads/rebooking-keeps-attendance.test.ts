import { expect, it, vi } from 'vitest'
import { setAppointment } from '@/lib/actions/appointments'
import { seedClient, serviceClient } from '../harness/helpers'

// The team's server action, signed in as someone who can see the lead
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ supabase: serviceClient(), profile: { id: 'team-member' } }),
  isImpersonating: async () => false,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const ATTENDANCE = 'status, appointment_at, appointment_confirmed, showed_up, arrival_confirmed_at'
type Attendance = {
  status: string
  appointment_at: string
  appointment_confirmed: boolean
  showed_up: boolean | null
  arrival_confirmed_at: string | null
}

it('keeps showed_up and arrival_confirmed_at when the team books a new appointment for a lead that attended', async () => {
  const { supabase, clientId } = await seedClient()
  const firstVisit = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
  const nextVisit = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  const { data: lead } = await supabase
    .from('leads')
    .insert({ client_id: clientId, name: 'كريم مصطفى', status: 'appointment_booked', appointment_at: firstVisit })
    .select('id')
    .single<{ id: string }>()
  const readLead = async () =>
    (await supabase.from('leads').select(ATTENDANCE).eq('id', lead!.id).single<Attendance>()).data!

  // The first visit happened
  await supabase.from('leads').update({ status: 'showed_up' }).eq('id', lead!.id)
  const attended = await readLead()
  expect(attended.showed_up).toBe(true)
  expect(attended.arrival_confirmed_at).not.toBeNull()

  expect(await setAppointment(lead!.id, nextVisit)).toEqual({ ok: true })

  const rebooked = await readLead()
  expect(new Date(rebooked.appointment_at).getTime()).toBe(new Date(nextVisit).getTime())
  expect(rebooked.showed_up).toBe(true)
  expect(rebooked.arrival_confirmed_at).toBe(attended.arrival_confirmed_at)
  // The new time still starts unconfirmed
  expect(rebooked.appointment_confirmed).toBe(false)
})
