import { NextResponse, type NextRequest } from 'next/server'
import { testBot } from '@/lib/actions/playground'
import type { PlaygroundError } from '@/lib/types/playground'

const STATUS: Record<PlaygroundError, number> = {
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  validation: 400,
  rateLimited: 429,
  aiUnavailable: 502,
  limitReached: 403,
  subscriptionInactive: 403,
  impersonating: 403,
  unknown: 500,
}

/**
 * POST { messages: [{ role: 'user' | 'assistant', content, metadata? }], state? }
 * The website widget's own pipeline; nothing is persisted: the rows it would
 * have written come back in the response (metadata, state), to send with the
 * next message. Requires a signed-in client admin (or org/super admin) with
 * access to the client; team members get 403.
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/playground/[clientId]'>) {
  const { clientId } = await ctx.params

  let body: { messages?: unknown; state?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'validation' }, { status: 400 })
  }

  const result = await testBot(clientId, body.messages as Parameters<typeof testBot>[1], undefined, body.state)
  return NextResponse.json(result, { status: result.ok ? 200 : STATUS[result.error] })
}
