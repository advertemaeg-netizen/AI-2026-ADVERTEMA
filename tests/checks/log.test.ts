import { describe, expect, it } from 'vitest'
import { PostgrestError } from '@supabase/supabase-js'
import { errorForLog } from '@/lib/log'

/**
 * What of an error reaches the log: the class name and the codes, never
 * the contents a database, a provider or a parser put in it.
 */
describe('errorForLog', () => {
  it('keeps a Postgres error’s code and drops its message, details and hint', () => {
    const error = new PostgrestError({
      message: 'duplicate key value violates unique constraint "leads_phone_key"',
      details: 'Key (phone)=(+201001234567) already exists.',
      hint: 'patient name: منى',
      code: '23505',
    })
    const logged = JSON.stringify(errorForLog(error))
    expect(errorForLog(error)).toEqual({ name: 'PostgrestError', code: '23505' })
    expect(logged).not.toContain('201001234567')
    expect(logged).not.toContain('منى')
  })

  it('keeps a plain object error’s code only', () => {
    expect(errorForLog({ code: 'PGRST116', message: 'secret row', details: 'x' })).toEqual({ code: 'PGRST116' })
  })

  it('drops a provider error’s request and response bodies, keeping its status', () => {
    const error = Object.assign(new (class APICallError extends Error {})('the model said: your patient Mona …'), {
      name: 'AI_APICallError',
      statusCode: 503,
      requestBodyValues: { messages: [{ role: 'user', content: 'عندي ألم في ضرسي' }] },
      responseBody: '{"error":"overloaded"}',
    })
    expect(errorForLog(error)).toEqual({ name: 'AI_APICallError', status: 503 })
  })

  it('drops a parse error’s quoted input', () => {
    let caught: unknown
    try {
      JSON.parse('{"phone": "+20100123')
    } catch (error) {
      caught = error
    }
    expect(errorForLog(caught)).toEqual({ name: 'SyntaxError' })
  })

  it('keeps a plain Error’s message: ours, fixed, carrying codes only', () => {
    expect(errorForLog(new Error('Failed to load channels: 42501'))).toEqual({ name: 'Error', message: 'Failed to load channels: 42501' })
  })

  it('keeps one level of cause, and drops anything that is not a short identifier', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { name: 'ConnectError', code: 'ECONNRESET' }) })
    expect(errorForLog(error)).toEqual({ name: 'TypeError', cause: { name: 'ConnectError', code: 'ECONNRESET' } })
    expect(errorForLog({ code: 'a value with spaces and a phone +201001234567' })).toEqual({})
  })

  it('says what a non-object was without printing it', () => {
    expect(errorForLog('+201001234567')).toBe('string')
    expect(errorForLog(undefined)).toBe('undefined')
  })
})
