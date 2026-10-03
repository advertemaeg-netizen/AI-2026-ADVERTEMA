import 'server-only'
import { estimateTokens, recordAiUsage, tokensFromMetadata, type AiUsageContext, type GeminiUsageMetadata } from '@/lib/ai/usage'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
// gemini-2.5-flash is no longer offered to new API users
const DEFAULT_MODEL = 'gemini-3.8-flash'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: GeminiUsageMetadata
}

export function geminiModel() {
  return process.env.GOOGLE_GEMINI_MODEL || DEFAULT_MODEL
}

export type GeminiContent = { role: 'user' | 'model'; parts: { text: string }[] }

/** The exact `contents` payload sent to Gemini for a chat history. */
export function toGeminiContents(history: ChatTurn[]): GeminiContent[] {
  // Gemini requires the conversation to start with a user turn
  const firstUser = history.findIndex((turn) => turn.role === 'user')
  return history.slice(Math.max(firstUser, 0)).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }))
}

const REPLY_TIMEOUT_MS = 30_000
// So a slow answer costs the visitor a wait, not the reply (at most twice the timeout)
const REPLY_TIMEOUT_RETRIES = 1
// 503: the model is overloaded. Waits before the second and third attempt,
// each stretched at random between half and one and a half times, so
// requests that failed together don't all come back together
const REPLY_OVERLOADED_BACKOFF_MS = [500, 1500]

/** An error response from Gemini, with its HTTP status */
export class GeminiError extends Error {
  constructor(
    public status: number,
    body: string
  ) {
    super(`Gemini request failed (${status}): ${body}`)
    this.name = 'GeminiError'
  }
}

/** AbortSignal.timeout() rejects with a DOMException named TimeoutError */
function isTimeout(error: unknown) {
  return error instanceof Error && error.name === 'TimeoutError'
}

export type AiFailureReason = 'rate_limited' | 'timeout' | 'overloaded' | 'error'

/** Why a reply could not be generated, for the record kept with the fallback */
export function aiFailureReason(error: unknown): AiFailureReason {
  if (isTimeout(error)) return 'timeout'
  if (error instanceof GeminiError) {
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
  responseSchema?: Record<string, unknown>
  usage?: AiUsageContext
}): Promise<string> {
  const apiKey = apiKeyOrThrow()
  const contents = toGeminiContents(history)
  const model = geminiModel()

  const request = async () => {
    const res = await fetch(`${API_BASE}/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        // No maxOutputTokens: on thinking models it also caps the hidden
        // reasoning, which cuts replies off. Length is steered in the prompt.
        generationConfig: {
          temperature,
          ...(responseSchema ? { responseMimeType: 'application/json', responseSchema } : {}),
        },
      }),
      signal: AbortSignal.timeout(REPLY_TIMEOUT_MS),
    })

    if (!res.ok) throw new GeminiError(res.status, await res.text())
    return (await res.json()) as GenerateContentResponse
  }

  // Nothing has been returned while this loop runs, so the caller has stored
  // and sent no reply yet
  let data: GenerateContentResponse
  let timeouts = 0
  let overloads = 0
  for (;;) {
    try {
      data = await request()
      break
    } catch (error) {
      const reason = aiFailureReason(error)
      if (reason === 'timeout' && timeouts < REPLY_TIMEOUT_RETRIES) {
        timeouts += 1
        console.warn(`[gemini] no reply within ${REPLY_TIMEOUT_MS / 1000}s; trying once more`)
      } else if (reason === 'overloaded' && overloads < REPLY_OVERLOADED_BACKOFF_MS.length) {
        const wait = Math.round(REPLY_OVERLOADED_BACKOFF_MS[overloads] * (0.5 + Math.random()))
        overloads += 1
        console.warn(`[gemini] model overloaded (503); trying again in ${wait}ms`)
        await new Promise((resolve) => setTimeout(resolve, wait))
      } else {
        throw error
      }
    }
  }

  // Billed even when the reply turns out empty
  void recordAiUsage(usage, model, tokensFromMetadata(data.usageMetadata))
  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('')
    .trim()

  if (!text) throw new Error('Gemini returned an empty response')
  return text
}

/**
 * Structured output (JSON mode): the reply must match `responseSchema`
 * (Gemini's OpenAPI-subset schema). Returns the parsed, unvalidated JSON.
 */
export async function generateJson({
  systemPrompt,
  prompt,
  responseSchema,
  temperature = 0,
  model = geminiModel(),
  usage,
}: {
  systemPrompt: string
  prompt: string
  responseSchema: Record<string, unknown>
  temperature?: number
  model?: string
  usage?: AiUsageContext
}): Promise<unknown> {
  const apiKey = apiKeyOrThrow()
  const res = await fetch(`${API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new Error(`Gemini JSON request failed (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as GenerateContentResponse
  void recordAiUsage(usage, model, tokensFromMetadata(data.usageMetadata))
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('')
  if (!text) throw new Error('Gemini returned an empty JSON response')
  return JSON.parse(text)
}

// text-embedding-004 has been retired by Google (404); gemini-embedding-001
// supports the same 768 dimensions through outputDimensionality
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001'
export const EMBEDDING_DIMENSIONS = 768
const EMBED_BATCH_SIZE = 100 // API limit per batchEmbedContents call

type EmbeddingTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

function embeddingModel() {
  return process.env.GOOGLE_GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
}

function apiKeyOrThrow() {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set')
  return apiKey
}

/**
 * Embeds many texts, batching requests; output order matches input order.
 * The embedding API doesn't report token counts, so the log estimates them.
 */
export async function embedTexts(
  texts: string[],
  taskType: EmbeddingTask,
  usage?: AiUsageContext
): Promise<number[][]> {
  const apiKey = apiKeyOrThrow()
  const model = embeddingModel()
  const vectors: number[][] = []
  let embeddedTokens = 0

  // Batches already embedded are billed even if a later one fails
  try {
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
      const res = await fetch(`${API_BASE}/${model}:batchEmbedContents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            taskType,
            outputDimensionality: EMBEDDING_DIMENSIONS,
          })),
        }),
        signal: AbortSignal.timeout(60_000),
      })

      if (!res.ok) {
        throw new Error(`Gemini embedding failed (${res.status}): ${await res.text()}`)
      }

      const data = (await res.json()) as { embeddings?: { values?: number[] }[] }
      embeddedTokens += batch.reduce((sum, text) => sum + estimateTokens(text), 0)
      const values = data.embeddings?.map((e) => e.values ?? [])
      if (!values || values.length !== batch.length || values.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
        throw new Error('Gemini returned an unexpected embedding response')
      }
      vectors.push(...values)
    }
  } finally {
    if (embeddedTokens > 0) {
      void recordAiUsage(usage, model, { promptTokens: embeddedTokens, completionTokens: 0, totalTokens: embeddedTokens })
    }
  }
  return vectors
}

export async function embedQuery(text: string, usage?: AiUsageContext): Promise<number[]> {
  const [vector] = await embedTexts([text], 'RETRIEVAL_QUERY', usage)
  return vector
}
