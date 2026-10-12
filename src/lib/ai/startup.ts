import 'server-only'
import { resolveAiConfig } from '@/lib/ai/provider'

/**
 * Logs the AI configuration this instance runs on, or stops the process when
 * a required variable is missing. Called once at startup (instrumentation.ts).
 */
export function logAiConfigOrExit() {
  let ai: ReturnType<typeof resolveAiConfig>
  try {
    ai = resolveAiConfig()
  } catch (error) {
    // An error thrown from the instrumentation hook is logged by Next.js, but
    // the process stays up and answers every request with a 500. Exiting is
    // what makes the container visibly fail to start.
    console.error(`[ai] refusing to start: ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
  console.log(
    `[ai] chat: ${ai.chatProvider} (reply ${ai.replyModel}, analysis ${ai.analysisModel}) · ` +
      `embeddings: ${ai.embeddingProvider} (${ai.embeddingModel}, ${ai.embeddingDimensions} dimensions)`
  )
}
