import {
  APPOINTMENT_PLACEHOLDER,
  SAVED_NAME_PLACEHOLDER,
  SAVED_PHONE_PLACEHOLDER,
  renderReply,
  type BookingOutcome,
  type ReplyLanguage,
} from '@/lib/ai/appointment'
import type { ContactEvents } from '@/lib/ai/contact'
import { displayPhone, normalizePhone, phoneLikeRuns } from '@/lib/phone'
import ar from '../../../messages/ar.json'
import en from '../../../messages/en.json'

/**
 * The reply as the visitor gets it: the model's text, with everything that is
 * a fact about the record written or checked by code.
 *
 * The model proposes; code decides. The model never knows what was saved, so
 * it must not be the one to say it: the appointment, whether a number was
 * accepted, and what name and number are on record all come from here.
 */

/** What the lead row holds, read after this message's writes */
export type SavedRecord = { name: string | null; phone: string | null }

const TEXTS = { ar: ar.botReplies.contact, en: en.botReplies.contact }
// Sentences as renderReply splits them
const SENTENCE_END = /(?<=[.!?؟…\n])/
const digits = (text: string) => text.replace(/\D/g, '')

/**
 * {{saved_phone}} and {{saved_name}} → what is on record. A sentence about a
 * value that isn't on record is replaced by one that says so.
 */
function renderSaved(text: string, record: SavedRecord, language: ReplyLanguage) {
  if (!text.includes(SAVED_PHONE_PLACEHOLDER) && !text.includes(SAVED_NAME_PLACEHOLDER)) return text
  const t = TEXTS[language]
  return text
    .split(SENTENCE_END)
    .map((sentence) => {
      // A sentence begins with the space that followed the one before it
      const lead = sentence.match(/^\s*/)![0]
      if (sentence.includes(SAVED_PHONE_PLACEHOLDER) && !record.phone) return lead + t.noPhoneOnRecord
      if (sentence.includes(SAVED_NAME_PLACEHOLDER) && !record.name) return lead + t.noNameOnRecord
      return sentence
        .replaceAll(SAVED_PHONE_PLACEHOLDER, record.phone ? displayPhone(record.phone) : '')
        .replaceAll(SAVED_NAME_PLACEHOLDER, record.name ?? '')
    })
    .join('')
    .trim()
}

/**
 * The second net, for a model that ignores the placeholder: a sentence that
 * repeats a number the visitor sent, when that number is not the one on
 * record, is removed, and what is on record is stated instead. Seen on the
 * demo widget (12 October 2026): asked "did you save my number?", the bot
 * read a rejected number back from the transcript — "أيوه، الرقم اللي بعتّه
 * هو 879995233130" — while the lead's phone was null.
 */
function withoutUnsavedNumbers(text: string, record: SavedRecord, visitorMessages: string[], language: ReplyLanguage) {
  const sent = new Set(visitorMessages.flatMap(phoneLikeRuns).map(digits))
  if (sent.size === 0) return text
  const unsaved = (run: string) => sent.has(digits(run)) && (!record.phone || normalizePhone(run) !== record.phone)

  const sentences = text.split(SENTENCE_END)
  const kept = sentences.filter((sentence) => !phoneLikeRuns(sentence).some(unsaved))
  if (kept.length === sentences.length) return text
  const t = TEXTS[language]
  const onRecord = record.phone ? t.phoneOnRecord.replace('{phone}', displayPhone(record.phone)) : t.noPhoneOnRecord
  return [kept.join('').trim(), onRecord].filter(Boolean).join('\n')
}

export function composeReply({
  template,
  outcome,
  events,
  record,
  visitorMessages,
  language,
  appointmentReported = false,
}: {
  /** The model's reply, placeholders included */
  template: string
  outcome: BookingOutcome
  /** What became of the name and number in this message */
  events: ContactEvents
  record: SavedRecord
  /** Every message the visitor wrote in this conversation, this one included */
  visitorMessages: string[]
  language: ReplyLanguage
  /** The model reported an appointment for this message (the outcome is what became of it) */
  appointmentReported?: boolean
}): string {
  const t = TEXTS[language]
  const refusals = [
    events.phone === 'rejected' ? t.phoneInvalid : events.phone === 'rejected_final' ? t.phoneGiveUp : null,
  ].filter((line): line is string => line !== null)

  // A number or a name code did not accept: the model wrote its reply before
  // anything had read them ("تمام يا م، رقمك وصل"), so none of it is kept.
  // Code says what is wrong, and where the booking stands.
  if (refusals.length > 0 || events.name === 'ask_again') {
    const booking = outcome.status === 'none' ? '' : renderReply('', outcome, language).trim()
    return [...refusals, booking || (events.name === 'ask_again' ? t.nameAsk : '')].filter(Boolean).join('\n')
  }

  // The model reported an appointment, code recorded it, and the model's
  // text never states it: that text was written against the booking ("محتاج
  // اسمك الرباعي الأول", or a refusal of a time that is in fact fine — both
  // seen in the eval of 12 October 2026, each followed by the system's own
  // "موعدك مؤكَّد ✅"). Two voices that disagree are worse than one: the record
  // speaks alone.
  const contradicted =
    appointmentReported && outcome.status === 'booked' && outcome.changed && !template.includes(APPOINTMENT_PLACEHOLDER)
  const rendered = renderReply(contradicted ? '' : template, outcome, language).trim()
  return withoutUnsavedNumbers(renderSaved(rendered, record, language), record, visitorMessages, language)
}
