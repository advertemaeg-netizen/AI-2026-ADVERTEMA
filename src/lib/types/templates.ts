import { z } from 'zod'

/**
 * WhatsApp message templates (the templates screen). The form is name,
 * language and body text, and nothing else: the category is UTILITY, fixed
 * in the code (src/lib/meta/templates.ts), with no field for it on the
 * screen. Decided by the owner: "UTILITY only. No category field on the
 * screen at all — hardcode it."
 */

/** Meta's rule for a template name: lowercase letters, digits and underscores, up to 512 */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]+$/
export const TEMPLATE_NAME_MAX = 512
/** Meta's limit for a BODY component's text */
export const TEMPLATE_BODY_MAX = 1024
/** The languages a clinic can write a template in: Meta's codes */
export const TEMPLATE_LANGUAGES = ['ar', 'en'] as const
export type TemplateLanguage = (typeof TEMPLATE_LANGUAGES)[number]

/**
 * A body with {{1}}-style variables needs example values Meta reviews, and
 * the form has no place for them: such a body is refused before it reaches
 * Meta rather than sent to be rejected there.
 */
const VARIABLE = /\{\{/

export const templateInputSchema = z.object({
  name: z.string().trim().min(1).max(TEMPLATE_NAME_MAX).regex(TEMPLATE_NAME_PATTERN),
  language: z.enum(TEMPLATE_LANGUAGES),
  body: z
    .string()
    .trim()
    .min(1)
    .max(TEMPLATE_BODY_MAX)
    .refine((text) => !VARIABLE.test(text)),
})
export type TemplateInput = z.infer<typeof templateInputSchema>

/**
 * Meta's statuses, folded to the four the screen shows:
 *   APPROVED                    approved
 *   PENDING, IN_APPEAL          pending (both are waiting on Meta)
 *   REJECTED                    rejected
 *   anything else (PAUSED, DISABLED, LIMIT_EXCEEDED, ARCHIVED, ...)  unavailable:
 *                               it exists and cannot be sent
 */
export type TemplateStatus = 'approved' | 'pending' | 'rejected' | 'unavailable'

export function templateStatus(metaStatus: unknown): TemplateStatus {
  switch (metaStatus) {
    case 'APPROVED':
      return 'approved'
    case 'PENDING':
    case 'IN_APPEAL':
      return 'pending'
    case 'REJECTED':
      return 'rejected'
    default:
      return 'unavailable'
  }
}

export type WhatsAppTemplate = {
  id: string
  name: string
  /** Meta's code as it answered: 'ar', 'en', 'en_US', ... */
  language: string
  status: TemplateStatus
  /** The BODY component's text; '' when it has none */
  body: string
}

/** One WhatsApp channel's templates, read live from Meta */
export type ChannelTemplates = {
  channelId: string
  channelName: string
  templates: WhatsAppTemplate[]
}

export type TemplateCreateError =
  | 'impersonating'
  | 'forbidden'
  /** The form's values break Meta's rules (the name pattern, the length, a variable) */
  | 'validation'
  /** A template with this name and language already exists on the account */
  | 'nameTaken'
  /** Meta refused, or could not be reached */
  | 'createFailed'

export type TemplateCreateResult = { ok: true; status: TemplateStatus } | { ok: false; error: TemplateCreateError }
