import { z } from 'zod'
import { LEAD_STATUSES } from '@/lib/types/leads'

/** A message of a test chat; a reply carries the trace the pipeline left in it (metadata), as a stored reply would */
export type PlaygroundMessage = { role: 'user' | 'assistant'; content: string; metadata?: Record<string, unknown> | null }

/**
 * What a test chat would have written, carried by the browser between
 * messages: nothing is stored, and the pipeline reads these lead rows
 * exactly as it would read the conversation's from the database. The shape
 * is the lead sink's own output (booking.ts, leadsInMemory), checked loosely
 * on the way back in.
 */
export const playgroundStateSchema = z.object({
  leads: z.array(
    z.object({
      id: z.string(),
      name: z.string().nullable(),
      phone: z.string().nullable(),
      status: z.enum(LEAD_STATUSES),
      appointment_at: z.string().nullable(),
      appointment_confirmed: z.boolean(),
      showed_up: z.boolean().nullable(),
      ai_appointment: z.unknown(),
      ai_extracted_data: z.unknown(),
      booking_draft: z.unknown(),
      branch_id: z.string().nullable(),
    })
  ),
})
export type PlaygroundState = z.infer<typeof playgroundStateSchema>

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
      /** The reply's trace, to send back as its message's metadata: the next reply reads it as it would from the database */
      metadata: Record<string, unknown> | null
      /** The lead rows as this message left them, to send back with the next */
      state: PlaygroundState
      /**
       * The reply reads as if this appointment (UTC ISO) had been booked.
       * Nothing was stored: the row is in `state`. The UI says so next to the reply.
       */
      simulatedAppointment?: string
    }
  | { ok: false; error: PlaygroundError }

export const PLAYGROUND_MAX_MESSAGES = 50
export const PLAYGROUND_MAX_MESSAGE_LENGTH = 4000
