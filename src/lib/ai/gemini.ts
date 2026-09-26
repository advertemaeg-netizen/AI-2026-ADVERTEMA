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

export async function generateReply({
  systemPrompt,
  history,
}: {
  systemPrompt: string
  history: ChatTurn[]
}): Promise<string> {
  const apiKey = process.env.GOOGLE_GEMINI_API_KEY
  if (!apiKey) throw new Error('GOOGLE_GEMINI_API_KEY is not set')

  // Gemini requires the conversation to start with a user turn
  const firstUser = history.findIndex((turn) => turn.role === 'user')
  const contents = history.slice(Math.max(firstUser, 0)).map((turn) => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }))

  const res = await fetch(`${API_BASE}/${geminiModel()}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.7 },
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
