import type { TokenCounts } from '@/lib/ai/usage'

/**
 * What the app needs from an AI provider, and nothing a provider-specific
 * request looks like. Each provider (src/lib/ai/providers/*) translates these
 * into its own API; retries, usage logging and error classification live
 * above this interface (src/lib/ai/provider.ts), once for every provider.
 */

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

type JsonType = 'object' | 'string' | 'number' | 'integer' | 'boolean'

/**
 * The subset of standard JSON Schema the app's structured outputs use.
 * Nullable is `type: [T, 'null']`. The order of the keys in `properties` is
 * the order the model writes them in, and is part of the schema: providers
 * must keep it. `propertyOrder` on the top-level object names that order
 * outright where it has to differ from the keys.
 */
export type JsonSchema = {
  type: JsonType | readonly [JsonType, 'null']
  properties?: Record<string, JsonSchema>
  required?: readonly string[]
  enum?: readonly string[]
  propertyOrder?: readonly string[]
}

/** What an embedding is for; some providers embed the two differently */
export type EmbeddingPurpose = 'document' | 'query'

/** An error response from a provider, with its HTTP status */
export class ProviderError extends Error {
  constructor(
    public provider: string,
    public status: number,
    body: string
  ) {
    super(`${provider} request failed (${status}): ${body}`)
    this.name = 'ProviderError'
  }
}

/** The model's text, before anything read it, and what the call used */
export type Completion = { text: string; tokens: TokenCounts }

/**
 * One attempt per call: no retries, no logging. An HTTP error response is
 * thrown as a ProviderError; running past `timeoutMs` rejects with an error
 * named TimeoutError (AbortSignal.timeout).
 */
export interface AiProvider {
  /** As it appears in error messages and logs */
  name: string
  replyModel(): string
  analysisModel(): string
  embeddingModel(): string
  /** Most texts the provider embeds in one request */
  embedBatchSize: number

  /** The assistant's next turn; JSON text matching `schema` when one is given */
  generateReply(request: {
    model: string
    systemPrompt: string
    history: ChatTurn[]
    temperature: number
    schema?: JsonSchema
    timeoutMs: number
  }): Promise<Completion>

  /** One prompt in, JSON text matching `schema` out */
  analyze(request: {
    model: string
    systemPrompt: string
    prompt: string
    schema: JsonSchema
    temperature: number
    timeoutMs: number
  }): Promise<Completion>

  /** One vector of `dimensions` numbers per text, in the same order */
  embed(request: {
    model: string
    texts: string[]
    purpose: EmbeddingPurpose
    dimensions: number
    timeoutMs: number
  }): Promise<{ vectors: number[][]; tokens: TokenCounts }>
}
