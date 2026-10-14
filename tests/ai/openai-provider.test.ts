import { afterEach, describe, expect, it, vi } from 'vitest'
import { harnessFetch } from '../harness/helpers'
import { BOT_REPLY_SCHEMA } from '@/lib/ai/appointment'
import { aiFailureReason, generateJson, generateReply } from '@/lib/ai/provider'
import { toOpenAiSchema } from '@/lib/ai/providers/openai'

const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

/** A chat completion carrying `content` */
const completion = (content: string) =>
  Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  })
const openaiError = (status: number) => Response.json({ error: { message: 'failed' } }, { status })

/** Routes the app's AI calls to OpenAI and answers them with `respond`; returns the request bodies sent */
function mockOpenAi(respond: (attempt: number) => Response) {
  vi.stubEnv('AI_PROVIDER', 'openai')
  vi.stubEnv('OPENAI_API_KEY', 'test-key')
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe('https://api.openai.com/v1/chat/completions')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-key')
    bodies.push(JSON.parse(String(init?.body)))
    return respond(bodies.length)
  })
  return bodies
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.stubGlobal('fetch', harnessFetch)
})

const ask = (schema = false) =>
  generateReply({
    systemPrompt: 'You are the assistant.',
    history: [
      { role: 'user', content: 'أهلاً' },
      { role: 'assistant', content: 'أهلاً بيك' },
      { role: 'user', content: 'عايز أحجز بكرة 6 المغرب' },
    ],
    temperature: 0.7,
    responseSchema: schema ? BOT_REPLY_SCHEMA : undefined,
  })

describe('the reply schema as OpenAI strict structured output', () => {
  const schema = toOpenAiSchema(BOT_REPLY_SCHEMA)

  it('keeps "contact", "appointment" and "other_answer" before "reply"', () => {
    expect(Object.keys(schema.properties!)).toEqual(['contact', 'appointment', 'other_answer', 'reply'])
    expect(schema.required).toEqual(['contact', 'appointment', 'other_answer', 'reply'])
  })

  it('closes every object and requires every property, optional ones as nullable', () => {
    const appointment = schema.properties!.appointment
    expect(schema.additionalProperties).toBe(false)
    expect(appointment.additionalProperties).toBe(false)
    // Optional at the top level, and declared nullable
    expect(appointment.type).toEqual(['object', 'null'])
    expect(appointment.required).toEqual(Object.keys(appointment.properties!))
    expect(appointment.required).toEqual(['day_type', 'weekday', 'day_of_month', 'month', 'year', 'hour', 'minute', 'period', 'needs_team_check'])
    // Required stays as it is; an optional enum also lists null
    expect(appointment.properties!.day_type.type).toBe('string')
    expect(appointment.properties!.day_type.enum).not.toContain(null)
    expect(appointment.properties!.weekday.type).toEqual(['string', 'null'])
    expect(appointment.properties!.weekday.enum).toContain(null)
    expect(appointment.properties!.hour.type).toEqual(['integer', 'null'])
    expect(schema.properties!.reply.type).toBe('string')
  })

  it('puts the keys propertyOrder names first, and the rest after them', () => {
    const ordered = toOpenAiSchema({
      type: 'object',
      properties: { c: { type: 'string' }, a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'],
      propertyOrder: ['a', 'b'],
    })
    expect(Object.keys(ordered.properties!)).toEqual(['a', 'b', 'c'])
    expect(ordered.properties!.a.type).toBe('string')
    expect(ordered.properties!.b.type).toEqual(['string', 'null'])
  })
})

describe('replies and analyses through OpenAI', () => {
  it('sends the conversation, the temperature and the strict schema to gpt-6-luna', async () => {
    const bodies = mockOpenAi(() => completion('{"appointment":null,"reply":"أهلاً"}'))

    expect(await ask(true)).toBe('{"appointment":null,"reply":"أهلاً"}')

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({
      model: 'gpt-6-luna',
      temperature: 0.7,
      // The model refuses a temperature unless reasoning is off
      reasoning_effort: 'none',
      messages: [
        { role: 'system', content: 'You are the assistant.' },
        { role: 'user', content: 'أهلاً' },
        { role: 'assistant', content: 'أهلاً بيك' },
        { role: 'user', content: 'عايز أحجز بكرة 6 المغرب' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'reply', strict: true } },
    })
    const sent = (bodies[0].response_format as { json_schema: { schema: { properties: object } } }).json_schema.schema
    // As it travels: JSON keeps the order the keys were written in
    expect(Object.keys(sent.properties)).toEqual(['contact', 'appointment', 'other_answer', 'reply'])
  })

  it('sends no response_format for a plain reply', async () => {
    const bodies = mockOpenAi(() => completion('أهلاً'))
    expect(await ask()).toBe('أهلاً')
    expect(bodies[0]).not.toHaveProperty('response_format')
  })

  it('drops the temperature when reasoning is switched on', async () => {
    vi.stubEnv('OPENAI_REASONING_EFFORT', 'low')
    const bodies = mockOpenAi(() => completion('أهلاً'))
    await ask()
    expect(bodies[0]).toMatchObject({ reasoning_effort: 'low' })
    expect(bodies[0]).not.toHaveProperty('temperature')
  })

  it('returns the analysis as parsed JSON, from gpt-6-luna', async () => {
    const bodies = mockOpenAi(() => completion('{"is_lead":true,"confidence":0.9}'))
    const result = await generateJson({
      systemPrompt: 'Analyze.',
      prompt: 'Conversation:\nVisitor: عايز أحجز',
      responseSchema: { type: 'object', properties: { is_lead: { type: 'boolean' }, confidence: { type: 'number' } }, required: ['is_lead', 'confidence'] },
    })
    expect(result).toEqual({ is_lead: true, confidence: 0.9 })
    expect(bodies[0]).toMatchObject({
      model: 'gpt-6-luna',
      temperature: 0,
      messages: [
        { role: 'system', content: 'Analyze.' },
        { role: 'user', content: 'Conversation:\nVisitor: عايز أحجز' },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true } },
    })
  })
})

describe('a failed OpenAI reply is tried again by the same rules as any provider', () => {
  it('never retries a 429', async () => {
    const bodies = mockOpenAi(() => openaiError(429))
    const error = await ask().catch((e) => e)
    expect(aiFailureReason(error)).toBe('rate_limited')
    expect(bodies).toHaveLength(1)
  })

  it('retries a 503 twice, then gives up as overloaded', async () => {
    const bodies = mockOpenAi(() => openaiError(503))
    const error = await ask().catch((e) => e)
    expect(aiFailureReason(error)).toBe('overloaded')
    expect(bodies).toHaveLength(3)
  })

  it('answers on the third attempt after two 503s', async () => {
    const bodies = mockOpenAi((attempt) => (attempt < 3 ? openaiError(503) : completion('أهلاً')))
    expect(await ask()).toBe('أهلاً')
    expect(bodies).toHaveLength(3)
  })

  it('retries a timeout once', async () => {
    let attempts = 0
    mockOpenAi(() => {
      attempts += 1
      throw timeout()
    })
    const error = await ask().catch((e) => e)
    expect(aiFailureReason(error)).toBe('timeout')
    expect(attempts).toBe(2)
  })

  it('does not retry any other error', async () => {
    const bodies = mockOpenAi(() => openaiError(500))
    const error = await ask().catch((e) => e)
    expect(aiFailureReason(error)).toBe('error')
    expect(bodies).toHaveLength(1)
  })
})
