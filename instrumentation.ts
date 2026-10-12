/**
 * Runs once when the server starts, before it takes a request.
 *
 * The AI configuration is resolved here so that a missing variable stops the
 * server instead of surfacing later as a bot that answers without its
 * knowledge base, and so that the first line of the log says which providers
 * and models this instance runs on.
 */
export async function register() {
  // Node.js only: the check ends the process, which the Edge runtime can't
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { logAiConfigOrExit } = await import('@/lib/ai/startup')
  logAiConfigOrExit()
}
