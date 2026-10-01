import type { BotDebug } from '@/lib/ai/bot'

export type PlaygroundMessage = { role: 'user' | 'assistant'; content: string }

export type PlaygroundError =
  | 'impersonating'
  | 'unauthorized'
  | 'forbidden'
  | 'notFound'
  | 'validation'
  | 'rateLimited'
  | 'aiUnavailable'
  | 'limitReached'
  | 'subscriptionInactive'
  | 'unknown'

export type PlaygroundResult =
  | {
      ok: true
      reply: string
      debug?: BotDebug
      /**
       * The reply reads as if this appointment (UTC ISO) had been booked.
       * Nothing was: a test chat has no lead. The UI says so next to the reply.
       */
      simulatedAppointment?: string
    }
  | { ok: false; error: PlaygroundError }

export const PLAYGROUND_MAX_MESSAGES = 50
export const PLAYGROUND_MAX_MESSAGE_LENGTH = 4000
