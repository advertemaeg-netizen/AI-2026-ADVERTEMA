import 'server-only'
import { recordAiUsage, type AiUsageContext } from '@/lib/ai/usage'
import { geminiProvider } from '@/lib/ai/providers/gemini'
import { openaiProvider } from '@/lib/ai/providers/openai'
import {
  ProviderError,
  type AiProvider,
  type ChatTurn,
  type EmbeddingPurpose,
  type JsonSchema,
} from '@/lib/ai/providers/types'

export { ProviderError, type ChatTurn, type EmbeddingPurpose, type JsonSchema }

/**
 * The app's AI calls: a reply, an analysis, an embedding. The provider behind
 * them is chosen by environment; retries, usage logging and the reading of
 * errors are here, the same for every provider.
 */

const PROVIDERS: Record<string, AiProvider> = {
  gemini: geminiProvider,
  openai: openaiProvider,
}
// The stored chunks are Gemini vectors: no other provider can embed for them
const EMBEDDING_PROVIDERS: Record<string, AiProvider> = {
  gemini: geminiProvider,
}
const DEFAULT_PROVIDER = 'gemini'

function providerNamed(providers: Record<string, AiProvider>, name: string, variable: string) {
  const provider = providers[name]
  if (!provider) throw new Error(`${variable}="${name}" is not a known AI provider (${Object.keys(providers).join(', ')})`)
  return provider
}

/** Replies and analyses (AI_PROVIDER) */
function chatProvider() {
  return providerNamed(PROVIDERS, process.env.AI_PROVIDER || DEFAULT_PROVIDER, 'AI_PROVIDER')
}

/**
 * Embeddings have their own switch (AI_EMBEDDING_PROVIDER) and do not follow
 * AI_PROVIDER: vectors from two models can't be compared, so the stored
 * chunks and the visitor's question must be embedded by the same one.
 * Changing it means re-embedding every chunk first.
 */
function embeddingProvider() {
  return providerNamed(EMBEDDING_PROVIDERS, process.env.AI_EMBEDDING_PROVIDER || DEFAULT_PROVIDER, 'AI_EMBEDDING_PROVIDER')
}

/** The model that writes replies, for the record kept with each one */
export function replyModel() {
  return chatProvider().replyModel()
}

const REPLY_TIMEOUT_MS = 30_000
// So a slow answer costs the visitor a wait, not the reply (at most twice the timeout)
const REPLY_TIMEOUT_RETRIES = 1
// 503: the model is overloaded. Waits before the second and third attempt,
// each stretched at random between half and one and a half times, so
// requests that failed together don't all come back together
const REPLY_OVERLOADED_BACKOFF_MS = [500, 1500]
const ANALYSIS_TIMEOUT_MS = 30_000
const EMBED_TIMEOUT_MS = 60_000

/** AbortSignal.timeout() rejects with a DOMException named TimeoutError */
function isTimeout(error: unknown) {
  return error instanceof Error && error.name === 'TimeoutError'
}

export type AiFailureReason = 'rate_limited' | 'timeout' | 'overloaded' | 'error'

/** Why an AI call failed, for the record kept with the fallback */
export function aiFailureReason(error: unknown): AiFailureReason {
  if (isTimeout(error)) return 'timeout'
  if (error instanceof ProviderError) {
    if (error.status === 429) return 'rate_limited'
    if (error.status === 503) return 'overloaded'
  }
  return 'error'
}

/**
 * `usage`: who the call is for, to log its tokens and cost (ai_usage).
 * A failed attempt generated no reply, so trying again can't produce two:
 * - no answer in time: once more
 * - 503 (overloaded): twice more, waiting a little longer each time
 * - 429 (quota or rate limit): never; another request would hit the same
 *   limit, so the caller falls back at once
 */
export async function generateReply({
  systemPrompt,
  history,
  temperature = 0.7,
  responseSchema,
  usage,
}: {
  systemPrompt: string
  history: ChatTurn[]
  temperature?: number
  /** Structured output: the reply is then JSON text matching this schema */
  responseSchema?: JsonSchema
  usage?: AiUsageContext
}): Promise<string> {
  const provider = chatProvider()
  const model = provider.replyModel()

  // Nothing has been returned while this loop runs, so the caller has stored
  // and sent no reply yet
  let completion: Awaited<ReturnType<AiProvider['generateReply']>>
  let timeouts = 0
  let overloads = 0
  for (;;) {
    try {
      completion = await provider.generateReply({
        model,
        systemPrompt,
        history,
        temperature,
        schema: responseSchema,
        timeoutMs: REPLY_TIMEOUT_MS,
      })
      break
    } catch (error) {
      const reason = aiFailureReason(error)
      if (reason === 'timeout' && timeouts < REPLY_TIMEOUT_RETRIES) {
        timeouts += 1
        console.warn(`[ai] no reply within ${REPLY_TIMEOUT_MS / 1000}s; trying once more`)
      } else if (reason === 'overloaded' && overloads < REPLY_OVERLOADED_BACKOFF_MS.length) {
        const wait = Math.round(REPLY_OVERLOADED_BACKOFF_MS[overloads] * (0.5 + Math.random()))
        overloads += 1
        console.warn(`[ai] model overloaded (503); trying again in ${wait}ms`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      } else {
        throw error
      }
    }
  }

  // Billed even when the reply turns out empty
  void recordAiUsage(usage, model, completion.tokens)
  const text = completion.text.trim()
  if (!text) throw new Error(`${provider.name} returned an empty response`)
  return text
}

/**
 * Structured output (JSON mode) from the analysis model: the answer must
 * match `responseSchema`. Returns the parsed, unvalidated JSON. One attempt.
 */
export async function generateJson({
  systemPrompt,
  prompt,
  responseSchema,
  temperature = 0,
  usage,
}: {
  systemPrompt: string
  prompt: string
  responseSchema: JsonSchema
  temperature?: number
  usage?: AiUsageContext
}): Promise<unknown> {
  const provider = chatProvider()
  const model = provider.analysisModel()
  const completion = await provider.analyze({
    model,
    systemPrompt,
    prompt,
    schema: responseSchema,
    temperature,
    timeoutMs: ANALYSIS_TIMEOUT_MS,
  })
  void recordAiUsage(usage, model, completion.tokens)
  if (!completion.text) throw new Error(`${provider.name} returned an empty JSON response`)
  return JSON.parse(completion.text)
}

/** The width of knowledge_documents.embedding; every provider is asked for it */
export const EMBEDDING_DIMENSIONS = 768

/** Embeds many texts, batching requests; output order matches input order. */
export async function embedTexts(
  texts: string[],
  purpose: EmbeddingPurpose,
  usage?: AiUsageContext
): Promise<number[][]> {
  const provider = embeddingProvider()
  const model = provider.embeddingModel()
  const vectors: number[][] = []
  let embeddedTokens = 0

  // Batches already embedded are billed even if a later one fails
  try {
    for (let i = 0; i < texts.length; i += provider.embedBatchSize) {
      const batch = texts.slice(i, i + provider.embedBatchSize)
      const result = await provider.embed({
        model,
        texts: batch,
        purpose,
        dimensions: EMBEDDING_DIMENSIONS,
        timeoutMs: EMBED_TIMEOUT_MS,
      })
      embeddedTokens += result.tokens.promptTokens
      if (result.vectors.length !== batch.length || result.vectors.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error(`${provider.name} returned an unexpected embedding response`)
      }
      vectors.push(...result.vectors)
    }
  } finally {
    if (embeddedTokens > 0) {
      void recordAiUsage(usage, model, { promptTokens: embeddedTokens, completionTokens: 0, totalTokens: embeddedTokens })
    }
  }
  return vectors
}

export async function embedQuery(text: string, usage?: AiUsageContext): Promise<number[]> {
  const [vector] = await embedTexts([text], 'query', usage)
  return vector
}
