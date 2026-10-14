import { z } from 'zod'
import { BOT_TIMEZONES, WEEK_DAYS, type WeekDay } from '@/lib/types/bot-settings'
import { UUID_PATTERN } from '@/lib/types/clients'

/** How long one slot is: the database accepts exactly these (branches.slot_minutes) */
export const SLOT_MINUTES = [15, 20, 30, 60] as const
export const CAPACITY_MAX = 50
export const BRANCH_NAME_MAX = 120
export const CLOSURE_REASON_MAX = 200
/** One closure request covers at most this many days (an Eid, a renovation week) */
export const CLOSURE_SPAN_MAX = 31
/** Ranges a day may hold: a split shift is two */
export const RANGES_PER_DAY_MAX = 3

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalidTime')

const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))

/**
 * The minutes of the day a range covers on its own day: one that closes
 * earlier than it opens runs past midnight, and only its part before midnight
 * is counted here (the rest belongs to the next day).
 */
function span([from, to]: [string, string]): [number, number] {
  const start = minutes(from)
  const end = minutes(to)
  return [start, end > start ? end : 24 * 60]
}

/** ["HH:MM","HH:MM"]; a range that closes earlier than it opens runs past midnight */
const range = z
  .tuple([clock, clock])
  .refine(([from, to]) => from !== to, 'emptyRange')

const dayRanges = z
  .array(range)
  .max(RANGES_PER_DAY_MAX, 'tooManyRanges')
  .refine((ranges) => {
    const sorted = ranges.map(span).sort((a, b) => a[0] - b[0])
    return sorted.every((current, i) => i === 0 || current[0] >= sorted[i - 1][1])
  }, 'overlap')
  // Only the last range of a day may run past midnight
  .refine((ranges) => ranges.filter(([from, to]) => minutes(to) < minutes(from)).length <= 1, 'overlap')

/**
 * A branch's week, as the database stores it (valid_branch_hours): every
 * weekday, each an array of ranges, empty when closed that day.
 */
export const branchHoursSchema = z.object(
  Object.fromEntries(WEEK_DAYS.map((day) => [day, dayRanges])) as Record<WeekDay, typeof dayRanges>
)

export type BranchHours = z.infer<typeof branchHoursSchema>

/** Editable fields of a branch — shared by the form (client) and the server action */
export const branchInputSchema = z.object({
  name: z.string().trim().min(1, 'required').max(BRANCH_NAME_MAX, 'tooLong'),
  timezone: z.enum(BOT_TIMEZONES),
  capacity_per_slot: z.number().int().min(1, 'capacity').max(CAPACITY_MAX, 'capacity'),
  slot_minutes: z.union([z.literal(15), z.literal(20), z.literal(30), z.literal(60)]),
  // Null: hours not set. The bot then records a time as a request the team confirms.
  business_hours: branchHoursSchema.nullable(),
  is_active: z.boolean(),
})

export type BranchInput = z.infer<typeof branchInputSchema>

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalidDate').refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'invalidDate')

/** A closure as entered: one day, or every day from `from` to `to` */
export const closureInputSchema = z
  .object({
    from: isoDate,
    to: isoDate,
    reason: z.string().trim().max(CLOSURE_REASON_MAX, 'tooLong'),
    /** Which branches it applies to: one, or every branch of the client (a public holiday) */
    branchIds: z.array(z.string().regex(UUID_PATTERN)).min(1, 'required'),
  })
  .refine(({ from, to }) => to >= from, { message: 'endBeforeStart', path: ['to'] })
  .refine(({ from, to }) => closureDates(from, to).length <= CLOSURE_SPAN_MAX, { message: 'spanTooLong', path: ['to'] })

export type ClosureInput = z.infer<typeof closureInputSchema>

/** Every date from `from` to `to`, both included (YYYY-MM-DD, as calendar days) */
export function closureDates(from: string, to: string): string[] {
  const dates: string[] = []
  const day = new Date(`${from}T00:00:00Z`)
  const last = new Date(`${to}T00:00:00Z`)
  while (day <= last && dates.length <= CLOSURE_SPAN_MAX) {
    dates.push(day.toISOString().slice(0, 10))
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return dates
}

/** A week with each day open the same hours, closed on the days given */
export function uniformWeek(from: string, to: string, closed: readonly WeekDay[] = []): BranchHours {
  return Object.fromEntries(WEEK_DAYS.map((day) => [day, closed.includes(day) ? [] : [[from, to]]])) as BranchHours
}

export const DEFAULT_BRANCH_INPUT: BranchInput = {
  name: '',
  timezone: 'Africa/Cairo',
  capacity_per_slot: 1,
  slot_minutes: 30,
  business_hours: null,
  is_active: true,
}

export type BranchClosure = { id: string; date: string; reason: string | null }

export type Branch = BranchInput & {
  id: string
  client_id: string
  created_at: string
  closures: BranchClosure[]
  /** Leads placed at this branch: a branch with any is deactivated, never deleted */
  leadCount: number
  /** Of those, appointments still ahead: a deactivated branch with any is a warning */
  upcomingCount: number
}

export type BranchActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'validation'
  | 'impersonating'
  | 'duplicateName'
  | 'hasLeads'
  | 'unknown'

export type BranchActionResult =
  | { ok: true; linkedLeads?: number; added?: number }
  | { ok: false; error: BranchActionError; fieldErrors?: Record<string, string> }
