import 'server-only'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateJson, type ChatTurn } from '@/lib/ai/gemini'
import { normalizeEgyptianPhone } from '@/lib/phone'
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

Extract details ONLY from what the visitor wrote. Never take a name, phone number or other detail from the assistant's messages — those often contain the business's own phone number or address.
- name: the visitor's name
- phone: the visitor's phone number exactly as written
- service_requested: what they want (product, service, order items)
- budget: any budget or price range they mention
- branch: a branch or location they mention
- preferred_time: a date/time they want (appointment, delivery)
- summary: one short sentence in Arabic describing the request
Use null for anything not stated.`

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
})

export type LeadAnalysis = z.infer<typeof analysisSchema>

export async function analyzeConversation(history: ChatTurn[]): Promise<LeadAnalysis> {
  const transcript = history
    .map((turn) => `${turn.role === 'user' ? 'Visitor' : 'Assistant'}: ${turn.content}`)
    .join('\n')
  const raw = await generateJson({
    systemPrompt: SYSTEM_PROMPT,
    prompt: `Conversation:\n${transcript}`,
    responseSchema: RESPONSE_SCHEMA,
    model: analysisModel(),
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
}

const LEAD_COLUMNS = 'id, name, phone, service_requested, budget, branch, confidence_score'

/**
 * Analyzes a conversation and creates or enriches its lead. Runs after the
 * reply has been sent (webhook `after()`), with the secret-key client.
 * AI never overwrites a field that already has a value, so human edits stick.
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
        status: 'new',
        confidence_score: analysis.confidence,
        ai_extracted_data: extracted,
      })
      if (!error) {
        await fillContactName(supabase, conversationId, analysis.name)
        return
      }
      // 23505: a concurrent analysis created it first — enrich that one
      if (error.code !== '23505') throw error
      ;({ data: existing } = await findExisting())
      if (!existing) return
    }

    const patch: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(fields)) {
      if (value && !existing[key as keyof typeof fields]) patch[key] = value
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
