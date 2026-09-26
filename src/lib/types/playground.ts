import type { BotDebug } from '@/lib/ai/bot'

export type PlaygroundMessage = { role: 'user' | 'assistant'; content: string }

export type PlaygroundError = 'unauthorized' | 'notFound' | 'validation' | 'rateLimited' | 'aiUnavailable'

export type PlaygroundResult =
  | { ok: true; reply: string; debug?: BotDebug }
  | { ok: false; error: PlaygroundError }

export const PLAYGROUND_MAX_MESSAGES = 50
export const PLAYGROUND_MAX_MESSAGE_LENGTH = 4000
