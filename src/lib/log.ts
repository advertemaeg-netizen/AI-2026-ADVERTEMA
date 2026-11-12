/**
 * WHAT OF AN ERROR GOES INTO THE LOG: its kind and its codes, never its
 * contents.
 *
 * A whole error object carries whatever its source put in it. A Postgres
 * error's message, details and hint quote the values of the row that failed
 * ("Key (phone)=(+20...) already exists"), a model provider's error carries
 * the request it was answering (the patient's messages, the knowledge text)
 * and the body Meta or the model answered with, and a JSON parse error quotes
 * the text it choked on. So a log line is a fixed message of ours (the label
 * at the call site) plus this: the error's class name, and its codes.
 *
 *   name     PostgrestError, AI_APICallError, TypeError, AbortError, ...
 *   code     Postgres SQLSTATE (23505), PostgREST (PGRST116), Node (ECONNRESET)
 *   status   HTTP status, where the error has one
 *   message  ONLY for a plain `Error`: that class is what our own code throws,
 *            with fixed messages and codes (never a database's message: those
 *            throw sites interpolate `error.code`). Every library error here
 *            is a subclass with its own name, and keeps its message out.
 * Anything that is not a short identifier is dropped, not truncated.
 */

const IDENTIFIER = /^[\w.:-]{1,64}$/
const MESSAGE_MAX = 200

function identifier(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && IDENTIFIER.test(value)) return value
  return undefined
}

export type LoggedError = { name?: string; code?: string | number; status?: string | number; message?: string; cause?: LoggedError }

export function errorForLog(error: unknown, depth = 0): LoggedError | string {
  if (error === null || error === undefined) return String(error)
  if (typeof error !== 'object') return typeof error
  const source = error as Record<string, unknown>
  const out: LoggedError = {}
  const name = identifier(source.name ?? (error instanceof Error ? 'Error' : undefined))
  if (typeof name === 'string') out.name = name
  const code = identifier(source.code)
  if (code !== undefined) out.code = code
  const status = identifier(source.status ?? source.statusCode)
  if (status !== undefined) out.status = status
  if (error instanceof Error && error.constructor === Error && error.name === 'Error' && typeof error.message === 'string') {
    out.message = error.message.slice(0, MESSAGE_MAX)
  }
  // One level of cause: "fetch failed" says little without its ECONNRESET
  if (depth === 0 && source.cause !== undefined && typeof source.cause === 'object') {
    const cause = errorForLog(source.cause, 1)
    if (typeof cause === 'object' && Object.keys(cause).length) out.cause = cause
  }
  return out
}
