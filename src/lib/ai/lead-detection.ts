import 'server-only'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateJson, type ChatTurn } from '@/lib/ai/gemini'
import type { AiUsageContext } from '@/lib/ai/usage'
import {
  APPOINTMENT_COMPONENTS,
  APPOINTMENT_REQUEST_SCHEMA,
  appointmentRequestSchema,
} from '@/lib/ai/appointment'
import { recordAppointment } from '@/lib/ai/booking'
import { normalizeEgyptianPhone } from '@/lib/phone'
import { claimLeadAnalysis } from '@/lib/subscription-limits'
import type { BusinessHours } from '@/lib/types/bot-settings'
import { CLOSED_LEAD_STATUSES, type LeadExtractedData, type LeadStatus } from '@/lib/types/leads'

// A light model for the per-message analysis: it runs on every visitor
// message, and Gemini quotas are per model, so it doesn't eat into the
// chat model's quota
const DEFAULT_ANALYSIS_MODEL = 'gemini-3.5-flash-lite'

function analysisModel() {
  return process.env.GOOGLE_GEMINI_ANALYSIS_MODEL || DEFAULT_ANALYSIS_MODEL
}

/** Minimum confidence to *create* a lead (an open lead is always enriched) */
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
- preferred_time: a date/time they want (appointment, delivery), in their own words
- summary: one short sentence in Arabic describing the request
Use null for anything not stated.
`

// Only for messages the bot didn't answer: when it does, the reply call reads
// the appointment (the reply has to quote what was stored). Same components,
// same resolver either way.
const APPOINTMENT_PROMPT = `

Appointments ("appointment", null when the visitor asked for none):
${APPOINTMENT_COMPONENTS}
- With no specific day ("next week", "soon") or no time at all, "appointment" is null.`

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
  },
  required: ['is_lead', 'confidence'],
  propertyOrdering: [
    'is_lead', 'confidence', 'name', 'phone', 'service_requested',
    'budget', 'branch', 'preferred_time', 'summary',
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
  appointment: appointmentRequestSchema.nullish().catch(null),
})

export type LeadAnalysis = z.infer<typeof analysisSchema>

/**
 * `usage`: whose analysis this is, to log its cost. `withAppointment`: also
 * read the appointment the visitor asked for (messages the bot didn't answer).
 */
export async function analyzeConversation(
  history: ChatTurn[],
  usage?: AiUsageContext,
  withAppointment = false
): Promise<LeadAnalysis> {
  const transcript = history
    .map((turn) => `${turn.role === 'user' ? 'Visitor' : 'Assistant'}: ${turn.content}`)
    .join('\n')
  const raw = await generateJson({
    systemPrompt: withAppointment ? SYSTEM_PROMPT + APPOINTMENT_PROMPT : SYSTEM_PROMPT,
    prompt: `Conversation:\n${transcript}`,
    responseSchema: withAppointment
      ? { ...RESPONSE_SCHEMA, properties: { ...RESPONSE_SCHEMA.properties, appointment: APPOINTMENT_REQUEST_SCHEMA } }
      : RESPONSE_SCHEMA,
    model: analysisModel(),
    usage,
  })
  return analysisSchema.parse(raw)
}

type LeadRow = {
  id: string
  name: string | null
  phone: string | null
  service_requested: string | null
  budget: string | null
  branch: string | null
  confidence_score: number | null
  status: LeadStatus
  ai_extracted_data: LeadExtractedData | null
}

const LEAD_COLUMNS = 'id, name, phone, service_requested, budget, branch, confidence_score, status, ai_extracted_data'

// Matches BOT_HISTORY_LIMIT: the analysis sees as much as the bot does
const HISTORY_LIMIT = 20

const isClosed = (lead: LeadRow) => CLOSED_LEAD_STATUSES.includes(lead.status)

/**
 * What was said since the conversation's previous lead closed. Everything
 * before that belongs to the finished episode: analysing it again would turn
 * a returning customer's "thanks" into a new lead built from the old request.
 */
async function historySinceClosed(supabase: SupabaseClient, conversationId: string, closed: LeadRow): Promise<ChatTurn[]> {
  const { data: closing } = await supabase
    .from('lead_events')
    .select('created_at')
    .eq('lead_id', closed.id)
    .eq('event_type', 'status_changed')
    .in('to_value', CLOSED_LEAD_STATUSES)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ created_at: string }>()

  let query = supabase
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .in('role', ['user', 'assistant', 'agent'])
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT)
  if (closing) query = query.gt('created_at', closing.created_at)

  const { data, error } = await query.returns<{ role: string; content: string }[]>()
  if (error) throw error
  return data.reverse().map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }))
}

/**
 * Analyzes a conversation and creates or updates its open lead. Runs after
 * the reply has been sent (webhook `after()`), with the secret-key client.
 *
 * A lead is one sales episode: only the conversation's open lead (not
 * showed_up / no_show / lost) is enriched. When there is none and the visitor
 * shows intent, a new lead is opened; a returning customer's name and phone
 * carry over from their previous lead.
 *
 * The AI may replace a value only while it's still the one the AI itself set
 * last time (the visitor changed their mind); anything the team edited stays.
 * Appointments: when the bot answered, the reply path has already recorded
 * what the visitor asked for, and quoted it. When it didn't (`replied` false:
 * an agent has taken over, the message limit is reached, or the reply failed)
 * there is no reply to disagree with the record, so the appointment is read
 * here — through the same components and the same resolver — and stored
 * unconfirmed, marked as coming from the analysis.
 * Never throws.
 */
export async function detectLead({
  supabase,
  clientId,
  conversationId,
  sourceMessageId,
  history,
  replied,
  businessHours,
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  sourceMessageId: string | null
  history: ChatTurn[]
  /** The bot answered this message (so it's already counted as a message) */
  replied: boolean
  /** Settles a bare hour ("at 9") in an appointment read here */
  businessHours: BusinessHours | null
}) {
  try {
    // No AI cost without a usable subscription. Past the plan's messages the
    // bot is silent and analysis continues on a separate, capped allowance.
    if (!(await claimLeadAnalysis(supabase, clientId, replied))) return

    const loadLeads = async () => {
      const { data, error } = await supabase
        .from('leads')
        .select(LEAD_COLUMNS)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .returns<LeadRow[]>()
      if (error) throw error
      return data
    }

    const leads = await loadLeads()
    let existing = leads.find((lead) => !isClosed(lead)) ?? null
    /** The customer's latest finished episode, if they've been here before */
    const returningFrom = leads.findLast(isClosed) ?? null

    const turns = returningFrom ? await historySinceClosed(supabase, conversationId, returningFrom) : history
    if (!turns.some((turn) => turn.role === 'user')) return

    const analysis = await analyzeConversation(
      turns,
      { operation: 'lead_analysis', clientId, conversationId },
      !replied
    )
    // Nobody told the visitor anything, so it is never confirmed here
    const bookFromAnalysis = async () => {
      if (replied || !analysis.appointment) return
      await recordAppointment({
        supabase,
        clientId,
        conversationId,
        sourceMessageId,
        request: analysis.appointment,
        autoConfirm: false,
        businessHours,
        source: 'analysis',
      })
    }
    const phone = normalizeEgyptianPhone(analysis.phone)
    const extracted: LeadExtractedData & { phone_raw: string | null } = {
      ...analysis,
      phone,
      phone_raw: analysis.phone,
    }
    const fields = {
      name: analysis.name,
      phone,
      service_requested: analysis.service_requested,
      budget: analysis.budget,
      branch: analysis.branch,
    }

    if (!existing) {
      // A returning customer is already known: intent alone opens the lead
      const qualifies =
        analysis.is_lead &&
        analysis.confidence >= LEAD_CONFIDENCE_THRESHOLD &&
        (returningFrom !== null || phone !== null || analysis.name !== null)
      if (!qualifies) return

      const name = analysis.name ?? returningFrom?.name ?? null
      const { error } = await supabase.from('leads').insert({
        client_id: clientId,
        conversation_id: conversationId,
        source_message_id: sourceMessageId,
        ...fields,
        name,
        phone: phone ?? returningFrom?.phone ?? null,
        status: 'new',
        confidence_score: analysis.confidence,
        ai_extracted_data: extracted,
      })
      if (!error) {
        await fillContactName(supabase, conversationId, name)
        await bookFromAnalysis()
        return
      }
      // 23505: a concurrent analysis opened it first — enrich that one
      if (error.code !== '23505') throw error
      existing = (await loadLeads()).find((lead) => !isClosed(lead)) ?? null
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

    // Always stored, even when nothing changes: the lead keeps a trace of
    // what the model understood from the latest message
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
    await bookFromAnalysis()
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
