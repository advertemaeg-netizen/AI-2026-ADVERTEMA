import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { AiUsageOperation } from '@/lib/types/ai-usage'

/**
 * Logs what each Gemini call cost (ai_usage). The database fills in the
 * organization from the client and prices the call with the model's current
 * price, so a later price change doesn't rewrite history. Logging never
 * fails the call it describes.
 */

export type AiOperation = AiUsageOperation

/** Who a call is for; passed down to the Gemini helpers */
export type AiUsageContext = {
  operation: AiOperation
  clientId: string
  conversationId?: string | null
}

export type TokenCounts = { promptTokens: number; completionTokens: number; totalTokens: number }

/** Gemini's usageMetadata (generateContent responses) */
export type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  /** Thinking tokens: billed as output */
  thoughtsTokenCount?: number
  toolUsePromptTokenCount?: number
  totalTokenCount?: number
}

export function tokensFromMetadata(meta: GeminiUsageMetadata | undefined): TokenCounts {
  const promptTokens = (meta?.promptTokenCount ?? 0) + (meta?.toolUsePromptTokenCount ?? 0)
  const completionTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0)
  return { promptTokens, completionTokens, totalTokens: meta?.totalTokenCount ?? promptTokens + completionTokens }
}

/**
 * Token estimate without a tokenizer: ~4 chars/token for Latin text, and
 * Arabic is denser (~2.5 chars/token), so count the two separately. Used
 * when the API doesn't report usage (embeddings).
 */
export function estimateTokens(text: string) {
  const arabic = text.match(/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/g)?.length ?? 0
  return Math.ceil(arabic / 2.5 + (text.length - arabic) / 4)
}

// Models already reported as unpriced by this server instance
const warnedUnpriced = new Set<string>()

/**
 * Never throws: a failed log is written to the server log and the caller
 * carries on. A model without a row in model_pricing is logged with no cost;
 * that is said out loud (once per model), because a missing price otherwise
 * only shows as AI costs that look lower than they are.
 */
export async function recordAiUsage(context: AiUsageContext | undefined, model: string, tokens: TokenCounts) {
  if (!context) return
  try {
    const { data, error } = await createAdminClient()
      .from('ai_usage')
      .insert({
        client_id: context.clientId,
        conversation_id: context.conversationId ?? null,
        operation: context.operation,
        model,
        prompt_tokens: Math.max(0, Math.round(tokens.promptTokens)),
        completion_tokens: Math.max(0, Math.round(tokens.completionTokens)),
        total_tokens: Math.max(0, Math.round(tokens.totalTokens)),
      })
      .select('estimated_cost_usd')
      .single<{ estimated_cost_usd: number | null }>()
    if (error) throw error
    if (data.estimated_cost_usd === null && !warnedUnpriced.has(model)) {
      warnedUnpriced.add(model)
      console.warn(`[ai-usage] model "${model}" has no price in model_pricing: its calls are logged without a cost`)
    }
  } catch (error) {
    console.error(`[ai-usage] logging ${context.operation} for client ${context.clientId} failed`, error)
  }
}
