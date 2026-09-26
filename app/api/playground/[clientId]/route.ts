import { NextResponse, type NextRequest } from 'next/server'
import { testBot } from '@/lib/actions/playground'
import type { PlaygroundError } from '@/lib/types/playground'

const STATUS: Record<PlaygroundError, number> = {
  unauthorized: 401,
  notFound: 404,
  validation: 400,
  rateLimited: 429,
  aiUnavailable: 502,
}

/**
 * POST { messages: [{ role: 'user' | 'assistant', content }], debug?: boolean }
 * Same assistant as the website widget; nothing is persisted. Requires a
 * signed-in dashboard user with access to the client.
 */
export async function POST(request: NextRequest, ctx: RouteContext<'/api/playground/[clientId]'>) {
  const { clientId } = await ctx.params

  let body: { messages?: unknown; debug?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'validation' }, { status: 400 })
  }

  const result = await testBot(
    clientId,
    body.messages as Parameters<typeof testBot>[1],
    body.debug === true
  )
  return NextResponse.json(result, { status: result.ok ? 200 : STATUS[result.error] })
}
