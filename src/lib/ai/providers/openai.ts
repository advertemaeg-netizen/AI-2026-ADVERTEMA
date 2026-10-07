import 'server-only'
import type { TokenCounts } from '@/lib/ai/usage'
import { ProviderError, type AiProvider, type ChatTurn, type JsonSchema } from '@/lib/ai/providers/types'

const API_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-6-luna'

const NAME = 'OpenAI'

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null; refusal?: string | null } }[]
  usage?: {
    prompt_tokens?: number
    /** Includes the reasoning tokens, which are billed as output */
    completion_tokens?: number
    total_tokens?: number
  }
}

type OpenAiSchema = {
  type: string | string[]
  properties?: Record<string, OpenAiSchema>
  required?: string[]
  additionalProperties?: false
  enum?: (string | null)[]
}

/**
 * JSON Schema to what `strict: true` accepts: every object closed
 * (additionalProperties: false) and every property required. A property the
 * app's schema leaves optional becomes nullable instead, so the model writes
 * null where another provider would leave the key out; the app's parsers
 * read the two the same way.
 *
 * The model writes the properties in the order they are listed here, and the
 * app depends on it (see BOT_REPLY_SCHEMA): the keys keep the order they have
 * in `schema`, or the one `propertyOrder` names, with any key it leaves out
 * after those.
 */
export function toOpenAiSchema(schema: JsonSchema, optional = false): OpenAiSchema {
  const [type, declaredNullable] = typeof schema.type === 'string' ? [schema.type, false] : [schema.type[0], true]
  const nullable = declaredNullable || optional
  const result: OpenAiSchema = { type: nullable ? [type, 'null'] : type }
  // A nullable enum has to list null itself
  if (schema.enum) result.enum = nullable ? [...schema.enum, null] : [...schema.enum]
  if (schema.properties) {
    const properties = schema.properties
    const keys = Object.keys(properties)
    const ordered = schema.propertyOrder
      ? [...schema.propertyOrder.filter((key) => key in properties), ...keys.filter((key) => !schema.propertyOrder!.includes(key))]
      : keys
    const required = schema.required ?? []
    result.properties = Object.fromEntries(
      ordered.map((key) => [key, toOpenAiSchema(properties[key], !required.includes(key))])
    )
    result.required = ordered
    result.additionalProperties = false
  }
  return result
}

function apiKeyOrThrow() {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set')
  return apiKey
}

/**
 * These models only take a temperature with reasoning switched off (anything
 * else is refused with a 400: "Only the default (1) value is supported"). The
 * bot's temperature is a per-client setting, so reasoning is off unless
 * OPENAI_REASONING_EFFORT says otherwise; the temperature is then left out
 * and the model runs at its own.
 */
function sampling(temperature: number) {
  const effort = process.env.OPENAI_REASONING_EFFORT || 'none'
  return effort === 'none' ? { reasoning_effort: effort, temperature } : { reasoning_effort: effort }
}

function tokensFromUsage(usage: ChatCompletionResponse['usage']): TokenCounts {
  const promptTokens = usage?.prompt_tokens ?? 0
  const completionTokens = usage?.completion_tokens ?? 0
  return { promptTokens, completionTokens, totalTokens: usage?.total_tokens ?? promptTokens + completionTokens }
}

async function complete(
  model: string,
  messages: ChatMessage[],
  temperature: number,
  schema: { name: string; schema: JsonSchema } | undefined,
  timeoutMs: number
) {
  const apiKey = apiKeyOrThrow()
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      ...sampling(temperature),
      ...(schema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: schema.name, strict: true, schema: toOpenAiSchema(schema.schema) },
            },
          }
        : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new ProviderError(NAME, res.status, await res.text())
  const data = (await res.json()) as ChatCompletionResponse
  // A refusal comes back with no content: the caller treats it as an empty answer
  return { text: data.choices?.[0]?.message?.content ?? '', tokens: tokensFromUsage(data.usage) }
}

const toMessages = (systemPrompt: string, history: ChatTurn[]): ChatMessage[] => [
  { role: 'system', content: systemPrompt },
  ...history.map((turn) => ({ role: turn.role, content: turn.content })),
]

export const openaiProvider: AiProvider = {
  name: NAME,
  replyModel: () => process.env.OPENAI_MODEL || DEFAULT_MODEL,
  analysisModel: () => process.env.OPENAI_ANALYSIS_MODEL || DEFAULT_MODEL,
  // Not offered: see embed()
  embeddingModel: () => 'none',
  embedBatchSize: 0,

  generateReply({ model, systemPrompt, history, temperature, schema, timeoutMs }) {
    return complete(model, toMessages(systemPrompt, history), temperature, schema && { name: 'reply', schema }, timeoutMs)
  },

  analyze({ model, systemPrompt, prompt, schema, temperature, timeoutMs }) {
    return complete(model, toMessages(systemPrompt, [{ role: 'user', content: prompt }]), temperature, { name: 'analysis', schema }, timeoutMs)
  },

  /**
   * Embeddings stay on Gemini: the knowledge base is stored as Gemini
   * vectors, and a question embedded by another model matches none of them,
   * so the bot would answer without the knowledge base. This provider is not
   * selectable for them (AI_EMBEDDING_PROVIDER, src/lib/ai/provider.ts).
   */
  async embed() {
    throw new Error('OpenAI embeddings are not supported: the knowledge base is embedded with Gemini')
  },
}
