import 'server-only'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateJson, type ChatTurn } from '@/lib/ai/gemini'
import { normalizeEgyptianPhone } from '@/lib/phone'
import { cairoWallTimeToIso, describeCairoNow } from '@/lib/cairo-time'
import type { LeadExtractedData } from '@/lib/types/leads'

// A light model for the per-message analysis: it runs on every visitor
// message, and Gemini quotas are per model, so it doesn't eat into the
// chat model's quota
const DEFAULT_ANALYSIS_MODEL = 'gemini-3.5-flash-lite'

function analysisModel() {
  return process.env.GOOGLE_GEMINI_ANALYSIS_MODEL || DEFAULT_ANALYSIS_MODEL
}

/** Minimum confidence to *create* a lead (existing leads are always enriched) */
export const LEAD_CONFIDENCE_THRESHOLD = 0.7

const SYSTEM_PROMPT = `You analyze chat conversations between a website visitor and a business's AI assistant, to find sales leads.

Decide whether the VISITOR shows clear buying intent (wants to order, book, buy, get a quote, or be contacted about a service) and how confident you are, from 0 to 1. Greetings, general questions and small talk alone are not buying intent.

Extract details ONLY from what the visitor wrote. Never take a name, phone number or other detail that only appears in the assistant's messages — those often contain the business's own phone number or address. (If the assistant repeats something the visitor wrote, that's fine: the visitor still wrote it.)

The LATEST statement always wins. Visitors change their minds mid-conversation: "8 PM" then "make it 11:30", one name then a correction, one number then another. For every field, read the whole conversation in order and return the most recent value the visitor gave; a later change cancels everything before it on that field. Never return an earlier value that the visitor has since changed.

- name: the visitor's name
- phone: the visitor's phone number, with every digit, exactly as written. Numbers are often glued to words ("رقم التليفون01098273812") or written in Arabic digits (٠١٠…); copy all the digits. Never shorten, mask or replace digits with X.
- service_requested: what they want (product, service, order items)
- budget: any budget or price range they mention
- branch: a branch or location they mention
- preferred_time: a date/time they want (appointment, delivery)
- summary: one short sentence in Arabic describing the request
Use null for anything not stated.

Appointments (dates are in Cairo, Egypt):
- appointment_date (YYYY-MM-DD) and appointment_time (HH:MM, 24h): only when the visitor asks for or agrees to a specific day. If the visitor changes the day or time later ("عايز أغير المعاد", "خليها الساعة 11 ونص"), use ONLY the latest one — the earlier appointment is cancelled. Resolve relative days against the current Cairo date given below: "النهارده" today, "بكرة" tomorrow, "بعد بكرة" in two days, a weekday name means its next occurrence (today if it's still ahead).
- A bare hour like "الساعة 5" means 17:00 unless they say morning (الصبح). With only a part of the day, use morning 10:00, noon 13:00, afternoon (العصر) 16:00, evening (المغرب / بالليل) 19:00 and set appointment_time_approximate to true.
- A time change without a day keeps the day from the earlier request (e.g. "النهاردة الساعة 8" then "خليها 11 ونص" → today 23:30).
- If there's no specific day ("next week", "soon", "any time"), return null for both — the team will schedule it.`

// Gemini structured-output schema (OpenAPI subset)
const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_lead: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' },
    name: { type: 'STRING', nullable: true },
    phone: { type: 'STRING', nullable: true },
    service_requested: { type: 'STRING', nullable: true },
    budget: { type: 'STRING', nullable: true },
    branch: { type: 'STRING', nullable: true },
    preferred_time: { type: 'STRING', nullable: true },
    summary: { type: 'STRING', nullable: true },
    appointment_date: { type: 'STRING', nullable: true },
    appointment_time: { type: 'STRING', nullable: true },
    appointment_time_approximate: { type: 'BOOLEAN', nullable: true },
  },
  required: ['is_lead', 'confidence'],
  propertyOrdering: [
    'is_lead', 'confidence', 'name', 'phone', 'service_requested',
    'budget', 'branch', 'preferred_time', 'summary',
    'appointment_date', 'appointment_time', 'appointment_time_approximate',
  ],
}

const nullableText = z
  .string()
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim().slice(0, 300) : null))

const analysisSchema = z.object({
  is_lead: z.boolean(),
  confidence: z.number().transform((v) => Math.min(Math.max(v, 0), 1)),
  name: nullableText,
  phone: nullableText,
  service_requested: nullableText,
  budget: nullableText,
  branch: nullableText,
  preferred_time: nullableText,
  summary: nullableText,
  appointment_date: z
    .string()
    .nullish()
    .transform((v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)),
  appointment_time: z
    .string()
    .nullish()
    .transform((v) => (v && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null)),
  appointment_time_approximate: z.boolean().nullish().transform((v) => v ?? false),
})

export type LeadAnalysis = z.infer<typeof analysisSchema>

export async function analyzeConversation(history: ChatTurn[]): Promise<LeadAnalysis> {
  const transcript = history
    .map((turn) => `${turn.role === 'user' ? 'Visitor' : 'Assistant'}: ${turn.content}`)
    .join('\n')
  const raw = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    prompt: `Current date and time in Cairo: ${describeCairoNow()}\n\nConversation:\n${transcript}`,
    responseSchema: RESPONSE_SCHEMA,
    model: analysisModel(),
  })
  return analysisSchema.parse(raw)
}

// How far ahead an extracted appointment may be; anything else is a misread
const MAX_APPOINTMENT_DAYS_AHEAD = 180

/** The extracted Cairo date + time as an instant, or null if absent/implausible. */
function resolveAppointment(analysis: LeadAnalysis, now = Date.now()): string | null {
  if (!analysis.appointment_date || !analysis.appointment_time) return null
  const [year, month, day] = analysis.appointment_date.split('-').map(Number)
  const iso = cairoWallTimeToIso(year, month - 1, day, analysis.appointment_time)
  const at = new Date(iso).getTime()
  // An hour of slack for "today at 5" mentioned just after 5
  if (Number.isNaN(at) || at < now - 60 * 60 * 1000) return null
  if (at > now + MAX_APPOINTMENT_DAYS_AHEAD * 24 * 60 * 60 * 1000) return null
  return iso
}

type LeadRow = {
  id: string
  name: string | null
  phone: string | null
  service_requested: string | null
  budget: string | null
  branch: string | null
  confidence_score: number | null
  status: string
  appointment_at: string | null
  appointment_confirmed: boolean
  showed_up: boolean | null
  ai_extracted_data: LeadExtractedData | null
}

const LEAD_COLUMNS = `id, name, phone, service_requested, budget, branch, confidence_score, status,
  appointment_at, appointment_confirmed, showed_up, ai_extracted_data`

/** Same instant? (Postgres and JS format timestamps differently) */
function sameInstant(a: string | null | undefined, b: string | null | undefined) {
  return !!a && !!b && new Date(a).getTime() === new Date(b).getTime()
}

/**
 * Analyzes a conversation and creates or updates its lead. Runs after the
 * reply has been sent (webhook `after()`), with the secret-key client.
 * The AI may replace a value only while it's still the one the AI itself set
 * last time (the visitor changed their mind); anything the team edited stays.
 * Never throws.
 */
export async function detectLead({
  supabase,
  clientId,
  conversationId,
  sourceMessageId,
  history,
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  sourceMessageId: string | null
  history: ChatTurn[]
}) {
  try {
    const analysis = await analyzeConversation(history)
    const phone = normalizeEgyptianPhone(analysis.phone)
    const appointmentAt = resolveAppointment(analysis)
    const extracted: LeadExtractedData & { phone_raw: string | null } = {
      ...analysis,
      phone,
      phone_raw: analysis.phone,
      appointment_at: appointmentAt,
    }
    const fields = {
      name: analysis.name,
      phone,
      service_requested: analysis.service_requested,
      budget: analysis.budget,
      branch: analysis.branch,
    }

    const findExisting = () =>
      supabase
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('conversation_id', conversationId)
        .maybeSingle<LeadRow>()

    let { data: existing } = await findExisting()

    if (!existing) {
      const qualifies =
        analysis.is_lead &&
        analysis.confidence > LEAD_CONFIDENCE_THRESHOLD &&
        (phone !== null || analysis.name !== null)
      if (!qualifies) return

      const { error } = await supabase.from('leads').insert({
        client_id: clientId,
        conversation_id: conversationId,
        source_message_id: sourceMessageId,
        ...fields,
        // AI-set times are unconfirmed; the team confirms or adjusts them
        appointment_at: appointmentAt,
        status: appointmentAt ? 'appointment_booked' : 'new',
        confidence_score: analysis.confidence,
        ai_extracted_data: extracted,
      })
      if (!error) {
        await fillContactName(supabase, conversationId, analysis.name)
        return
      }
      // 23505: a concurrent analysis created it first — enrich that one
      if (error.code !== '23505') throw error
      existing = (await findExisting()).data
      if (!existing) return
    }

    const previous = existing.ai_extracted_data ?? {}
    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      const current = existing[key as keyof typeof fields]
      // Empty, or still the AI's own earlier value (not edited by the team)
      const aiOwned = !current || current === previous[key as keyof typeof fields]
      if (value && value !== current && aiOwned) patch[key] = value
    }

    // Appointment: fill or move it while it's the AI's own, unconfirmed and
    // not yet attended/missed. A time the team set or confirmed stays.
    const appointmentAiOwned =
      !existing.appointment_at ||
      (sameInstant(existing.appointment_at, previous.appointment_at) &&
        !existing.appointment_confirmed &&
        existing.showed_up === null)
    if (appointmentAt && appointmentAiOwned && !sameInstant(appointmentAt, existing.appointment_at)) {
      patch.appointment_at = appointmentAt
      if (existing.status === 'new' || existing.status === 'contacted') patch.status = 'appointment_booked'
    }
    if (Object.keys(patch).length === 0 && (existing.confidence_score ?? 0) >= analysis.confidence) return

    const { error } = await supabase
      .from('leads')
      .update({
        ...patch,
        confidence_score: Math.max(existing.confidence_score ?? 0, analysis.confidence),
        ai_extracted_data: extracted,
      })
      .eq('id', existing.id)
    if (error) throw error
    await fillContactName(supabase, conversationId, analysis.name)
  } catch (error) {
    console.error('[lead-detection] failed', error)
  }
}

/** Shows the visitor's name in the inbox instead of "Visitor ABC123". */
async function fillContactName(supabase: SupabaseClient, conversationId: string, name: string | null) {
  if (!name) return
  await supabase
    .from('conversations')
    .update({ contact_name: name })
    .eq('id', conversationId)
    .is('contact_name', null)
}
