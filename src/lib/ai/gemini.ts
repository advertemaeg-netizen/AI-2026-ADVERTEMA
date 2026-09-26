import 'server-only'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const DEFAULT_MODEL = 'gemini-2.5-flash'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

type GenerateContentResponse = {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
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

export async function generateReply({
  systemPrompt,
  history,
  temperature = 0.7,
}: {
  systemPrompt: string
  history: ChatTurn[]
  temperature?: number
}): Promise<string> {
  const apiKey = apiKeyOrThrow()
  const contents = toGeminiContents(history)

  const res = await fetch(`${API_BASE}/${geminiModel()}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      // No maxOutputTokens: on thinking models it also caps the hidden
      // reasoning, which cuts replies off. Length is steered in the prompt.
      generationConfig: { temperature },
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new Error(`Gemini request failed (${res.status}): ${await res.text()}`)
  }

  const data = (await res.json()) as GenerateContentResponse
  const text = data.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? '')
    .join('')
    .trim()

  if (!text) throw new Error('Gemini returned an empty response')
  return text
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

/** Embeds many texts, batching requests; output order matches input order. */
export async function embedTexts(texts: string[], taskType: EmbeddingTask): Promise<number[][]> {
  const apiKey = apiKeyOrThrow()
  const model = embeddingModel()
  const vectors: number[][] = []

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
    const values = data.embeddings?.map((e) => e.values ?? [])
    if (!values || values.length !== batch.length || values.some((v) => v.length !== EMBEDDING_DIMENSIONS)) {
      throw new Error('Gemini returned an unexpected embedding response')
    }
    vectors.push(...values)
  }

  return vectors
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text], 'RETRIEVAL_QUERY')
  return vector
}
