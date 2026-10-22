import type { SupabaseClient } from '@supabase/supabase-js'
import { openDaysOf, type Schedule } from '@/lib/ai/appointment'
import { cairoParts, CAIRO_TZ } from '@/lib/cairo-time'
import { WEEK_DAYS, type WeekDay } from '@/lib/types/bot-settings'
import { branchHoursSchema } from '@/lib/types/branches'

/**
 * THE BRANCH IS THE BOOKING RECORD (22 October 2026). A day is accepted only
 * against the hours and closures of the branch it is for, and the prompt
 * states those same hours (describeBranches): the model answers from the
 * record the code books from, never from a second copy in the knowledge base.
 *
 * One active branch is the branch, never asked about. With more than one, the
 * visitor's branch is a step of its own, asked by code (ask_branch) before a
 * day can be checked. A branch with no hours set has nothing to check: what
 * the visitor asks for there is a request, never a booking.
 */
export type BookingBranch = {
  id: string
  name: string
  /** Null: no hours entered (or none this code can trust), so nothing is checked */
  schedule: Schedule | null
}

// How far ahead closures are read: as far as a booking may be (MAX_DAYS_AHEAD)
const CLOSURES_AHEAD_DAYS = 180
// How far ahead the prompt lists them
const PROMPT_CLOSURE_DAYS = 30

const dayKey = (at: Date) => {
  const { year, month, day } = cairoParts(at)
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * The client's active branches, each with the schedule a booking is checked
 * against. Throws on a database error.
 *
 * TIMEZONE GUARD: every date and time here is worked out in Cairo. A branch
 * set to another zone gets no schedule, so nothing is confirmed there, and
 * says so loudly: computing a Riyadh clinic's hours on Cairo's clock would
 * book the wrong hour. Per-branch zones get built when a client needs one.
 */
export async function loadBookingBranches(supabase: SupabaseClient, clientId: string, now = new Date()): Promise<BookingBranch[]> {
  const { data, error } = await supabase
    .from('branches')
    .select('id, name, timezone, business_hours')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .returns<{ id: string; name: string; timezone: string; business_hours: unknown }[]>()
  if (error) throw error
  if (data.length === 0) return []

  const until = new Date(now.getTime() + CLOSURES_AHEAD_DAYS * 24 * 60 * 60 * 1000)
  const { data: closures, error: closuresError } = await supabase
    .from('branch_closures')
    .select('branch_id, date')
    .eq('client_id', clientId)
    .gte('date', dayKey(now))
    .lte('date', dayKey(until))
    .returns<{ branch_id: string; date: string }[]>()
  if (closuresError) throw closuresError

  return data.map((branch) => {
    const hours = branchHoursSchema.safeParse(branch.business_hours)
    if (branch.business_hours !== null && !hours.success) {
      console.error(`[booking] branch ${branch.id} of client ${clientId} has hours this code cannot read: nothing is checked there`)
    }
    if (hours.success && branch.timezone !== CAIRO_TZ) {
      console.error(`[booking] branch ${branch.id} of client ${clientId} is in ${branch.timezone}: hours are only worked out in ${CAIRO_TZ}, so nothing is checked there`)
      return { id: branch.id, name: branch.name, schedule: null }
    }
    const schedule: Schedule | null = hours.success
      ? {
          days: hours.data as Record<WeekDay, [string, string][]>,
          closures: closures.filter((c) => c.branch_id === branch.id).map((c) => c.date),
        }
      : null
    return { id: branch.id, name: branch.name, schedule }
  })
}

/**
 * A branch name as people type it, the way the database compares them
 * (normalize_branch_name, 20261028100000_branches.sql): case, the hamza
 * forms of alef, alef maqsura, taa marbuta, tatweel and harakat folded,
 * spaces collapsed, a leading «فرع» dropped. Only for matching: a name is
 * always shown exactly as the client wrote it.
 */
export function normalizeBranchName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـًٌٍَُِّْ]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^فرع /, '')
}

/**
 * The branch this message chose, or null. Code's decision, like the evidence
 * rule: the visitor's own message has to name the branch. The model's report
 * only settles which, when the message names more than one.
 */
export function branchInMessage(branches: BookingBranch[], message: string, reported: string | null): BookingBranch | null {
  const text = normalizeBranchName(message)
  const named = branches.filter((branch) => {
    const name = normalizeBranchName(branch.name)
    return name.length > 0 && text.includes(name)
  })
  if (reported) {
    const wanted = normalizeBranchName(reported)
    const match = named.find((branch) => normalizeBranchName(branch.name) === wanted)
    if (match) return match
  }
  return named.length === 1 ? named[0] : null
}

/** A branch by the name the draft holds, as stored */
export function branchNamed(branches: BookingBranch[], name: string | null): BookingBranch | null {
  if (!name) return null
  const wanted = normalizeBranchName(name)
  return branches.find((branch) => normalizeBranchName(branch.name) === wanted) ?? null
}

const DAY_ABBREVIATIONS: Record<WeekDay, string> = { sat: 'Sat', sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri' }

function describeWeek(schedule: Schedule) {
  if (openDaysOf(schedule).length === 0) return 'open on no day: not taking bookings.'
  const open = WEEK_DAYS.filter((day) => schedule.days[day].length > 0).map(
    (day) => `${DAY_ABBREVIATIONS[day]} ${schedule.days[day].map(([from, to]) => `${from}–${to}${to <= from ? ' (past midnight)' : ''}`).join(', ')}`
  )
  const closed = WEEK_DAYS.filter((day) => schedule.days[day].length === 0).map((day) => DAY_ABBREVIATIONS[day])
  return `${open.join('; ')}.${closed.length > 0 ? ` Closed ${closed.join(', ')}.` : ''}`
}

/**
 * The branches as the prompt states them: the same record the code books
 * from, so the model's answer about hours and the system's booking can't
 * drift apart. Empty when no branch has hours (the knowledge base is then
 * all there is, as before). About 45 tokens plus 40 per branch.
 */
export function describeBranches(branches: BookingBranch[], now = new Date()): string {
  if (!branches.some((branch) => branch.schedule)) return ''
  const soon = dayKey(new Date(now.getTime() + PROMPT_CLOSURE_DAYS * 24 * 60 * 60 * 1000))
  const lines = branches.map((branch) =>
    branch.schedule
      ? `- ${branch.name}: ${describeWeek(branch.schedule)}`
      : `- ${branch.name}: hours not entered here; answer about them only from the knowledge base.`
  )
  const closures = branches.flatMap((branch) =>
    (branch.schedule?.closures ?? []).filter((date) => date <= soon).map((date) => `${branch.name} ${date}`)
  )
  const today = new Intl.DateTimeFormat('en-GB', {
    timeZone: CAIRO_TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)
  return [
    `${branches.length > 1 ? 'Branches and their' : 'The business\'s'} opening hours (${CAIRO_TZ}). The system books visits from these and refuses any other day; answer every question about days and hours from them, never from the knowledge base:`,
    ...lines,
    `- Closed on these dates: ${closures.length > 0 ? closures.join('; ') : `none in the next ${PROMPT_CLOSURE_DAYS} days`}.`,
    `Now: ${today}.`,
    ...(branches.length > 1
      ? [`When the visitor's latest message names one of these branches, report it in "branch", written exactly as listed above; otherwise "branch" is null. The system asks which branch itself when it needs to.`]
      : []),
  ].join('\n')
}
