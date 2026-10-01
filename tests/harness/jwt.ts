import { createHmac } from 'node:crypto'

/** What PostgREST verifies tokens with in tests */
export const JWT_SECRET = 'test-only-jwt-secret-at-least-32-characters'

export function signJwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  return `${body}.${createHmac('sha256', JWT_SECRET).update(body).digest('base64url')}`
}
