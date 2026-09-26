import { z } from 'zod'

export const BOT_TONES = ['friendly', 'professional', 'formal', 'casual'] as const
export const BOT_LANGUAGES = ['ar', 'en', 'both'] as const
// Saturday first — the usual business week in Egypt and the Gulf
export const WEEK_DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const
export const BOT_TIMEZONES = [
  'Africa/Cairo',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Amman',
  'Europe/London',
] as const

export type BotTone = (typeof BOT_TONES)[number]
export type BotLanguage = (typeof BOT_LANGUAGES)[number]
export type WeekDay = (typeof WEEK_DAYS)[number]

export const SYSTEM_PROMPT_MAX = 4000
export const MESSAGE_MAX = 500

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalidTime')

const dayHours = z.object({ open: z.boolean(), from: time, to: time })

export const businessHoursSchema = z.object({
  enabled: z.boolean(),
  timezone: z.enum(BOT_TIMEZONES),
  // A closing time earlier than the opening time means it closes after midnight
  days: z.object(Object.fromEntries(WEEK_DAYS.map((day) => [day, dayHours])) as Record<WeekDay, typeof dayHours>),
})

/** Editable settings — shared by the form (client) and the server action. */
export const botSettingsSchema = z.object({
  system_prompt: z.string().trim().min(1, 'required').max(SYSTEM_PROMPT_MAX, 'tooLong'),
  tone: z.enum(BOT_TONES),
  language: z.enum(BOT_LANGUAGES),
  temperature: z.number().min(0).max(1),
  max_response_length: z.number().int().min(100).max(2000),
  welcome_message: z.string().trim().min(1, 'required').max(MESSAGE_MAX, 'tooLong'),
  fallback_message: z.string().trim().min(1, 'required').max(MESSAGE_MAX, 'tooLong'),
  lead_qualification_enabled: z.boolean(),
  business_hours: businessHoursSchema.nullable(),
})

export type BotSettingsInput = z.infer<typeof botSettingsSchema>
export type BusinessHours = z.infer<typeof businessHoursSchema>

export type BotSettings = BotSettingsInput & { client_id: string }

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  enabled: false,
  timezone: 'Africa/Cairo',
  days: Object.fromEntries(
    WEEK_DAYS.map((day) => [day, { open: day !== 'fri', from: '09:00', to: '17:00' }])
  ) as BusinessHours['days'],
}

export type BotSettingsActionResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'forbidden' | 'notFound' | 'validation' | 'unknown' }
