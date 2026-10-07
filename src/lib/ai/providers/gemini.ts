import 'server-only'
import { estimateTokens, type TokenCounts } from '@/lib/ai/usage'
import { ProviderError, type AiProvider, type ChatTurn, type JsonSchema } from '@/lib/ai/providers/types'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
// gemini-2.5-flash is no longer offered to new API users
const DEFAULT_MODEL = 'gemini-3.8-flash'
// A light model for the per-message analysis: it runs on every visitor
// message, and Gemini quotas are per model, so it doesn't eat into the
// chat model's quota
const DEFAULT_ANALYSIS_MODEL = 'gemini-3.5-flash-lite'
// text-embedding-004 has been retired by Google (404); gemini-embedding-001
// supports the same 768 dimensions through outputDimensionality
const DEFAULT_EMBEDDING_MODEL = 'gemini-embedding-001'

const NAME = 'Gemini'

type GeminiContent = { role: 'user' | 'model'; parts: { text: string }[] }

/** Gemini's usageMetadata (generateContent responses) */
type GeminiUsageMetadata = {
  promptTokenCount?: number
  candidatesTokenCount?: number
  /** Thinking tokens: billed as output */
  thoughtsTokenCount?: number
  toolUsePromptTokenCount?: number
  totalTokenCount?: number
}

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
  usageMetadata?: GeminiUsageMetadata
}

function tokensFromMetadata(meta: GeminiUsageMetadata | undefined): TokenCounts {
  const promptTokens = (meta?.promptTokenCount ?? 0) + (meta?.toolUsePromptTokenCount ?? 0)
  const completionTokens = (meta?.candidatesTokenCount ?? 0) + (meta?.thoughtsTokenCount ?? 0)
  return { promptTokens, completionTokens, totalTokens: meta?.totalTokenCount ?? promptTokens + completionTokens }
}

/** The `contents` payload for a chat history */
function toGeminiContents(history: ChatTurn[]): GeminiContent[] {
  // Gemini requires the conversation to start with a user turn
  const firstUser = history.findIndex((turn) => turn.role === 'user')
  return history.slice(Math.max(firstUser, 0)).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }))
}

/**
 * JSON Schema to Gemini's structured-output schema (an OpenAPI subset):
 * upper-case types, `nullable` instead of a null type, and the order of the
 * top-level properties spelled out, since Gemini doesn't take it from the keys.
 */
function toGeminiSchema(schema: JsonSchema, root = true): Record<string, unknown> {
  const [type, nullable] = typeof schema.type === 'string' ? [schema.type, false] : [schema.type[0], true]
  return {
    type: type.toUpperCase(),
    ...(nullable ? { nullable: true } : {}),
    ...(schema.enum ? { enum: schema.enum } : {}),
    ...(schema.properties
      ? {
          properties: Object.fromEntries(
            Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value, false)])
          ),
        }
      : {}),
    ...(schema.required ? { required: schema.required } : {}),
    ...(root && schema.properties ? { propertyOrdering: schema.propertyOrder ?? Object.keys(schema.properties) } : {}),
  }
}

function apiKeyOrThrow() {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set')
  return apiKey
}

async function post<T>(model: string, method: string, body: unknown, timeoutMs: number): Promise<T> {
  const apiKey = apiKeyOrThrow()
  const res = await fetch(`${API_BASE}/${model}:${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new ProviderError(NAME, res.status, await res.text())
  return (await res.json()) as T
}

function completion(data: GenerateContentResponse) {
  return {
    text: data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '',
    tokens: tokensFromMetadata(data.usageMetadata),
  }
}

export const geminiProvider: AiProvider = {
  name: NAME,
  replyModel: () => process.env.GOOGLE_GEMINI_MODEL || DEFAULT_MODEL,
  analysisModel: () => process.env.GOOGLE_GEMINI_ANALYSIS_MODEL || DEFAULT_ANALYSIS_MODEL,
  embeddingModel: () => process.env.GOOGLE_GEMINI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL,
  embedBatchSize: 100, // API limit per batchEmbedContents call

  async generateReply({ model, systemPrompt, history, temperature, schema, timeoutMs }) {
    const data = await post<GenerateContentResponse>(
      model,
      'generateContent',
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: toGeminiContents(history),
        // No maxOutputTokens: on thinking models it also caps the hidden
        // reasoning, which cuts replies off. Length is steered in the prompt.
        generationConfig: {
          temperature,
          ...(schema ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) } : {}),
        },
      },
      timeoutMs
    )
    return completion(data)
  },

  async analyze({ model, systemPrompt, prompt, schema, temperature, timeoutMs }) {
    const data = await post<GenerateContentResponse>(
      model,
      'generateContent',
      {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: toGeminiSchema(schema) },
      },
      timeoutMs
    )
    return completion(data)
  },

  async embed({ model, texts, purpose, dimensions, timeoutMs }) {
    const data = await post<{ embeddings?: { values?: number[] }[] }>(
      model,
      'batchEmbedContents',
      {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: purpose === 'document' ? 'RETRIEVAL_DOCUMENT' : 'RETRIEVAL_QUERY',
          outputDimensionality: dimensions,
        })),
      },
      timeoutMs
    )
    // The embedding API doesn't report token counts, so they are estimated
    const promptTokens = texts.reduce((sum, text) => sum + estimateTokens(text), 0)
    return {
      vectors: data.embeddings?.map((e) => e.values ?? []) ?? [],
      tokens: { promptTokens, completionTokens: 0, totalTokens: promptTokens },
    }
  },
}
