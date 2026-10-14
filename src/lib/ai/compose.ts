import {
  APPOINTMENT_PLACEHOLDER,
  SAVED_NAME_PLACEHOLDER,
  SAVED_PHONE_PLACEHOLDER,
  appointmentLine,
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

/**
 * What code holds for this visitor after their message, or has stopped
 * asking for: what a question in the reply must not be about, and what the
 * next one should be.
 */
export type Known = {
  /** As given, a full name or not: code is no longer asking for it */
  name: string | null
  phone: string | null
  /** The bot has stopped asking for the number; a person takes it */
  phoneGivenUp: boolean
  /** A day and time are on record, as an appointment or as a request */
  time: boolean
}

// The VISITOR's name: اسمك، اسم حضرتك، الاسم (الرباعي…)، اسمين, "your name",
// "full name". Not someone else's ("اسم الدكتورة منة"), and not a word that
// only contains it (اسمح، قاسم): an answer about a doctor must not be dropped.
const NAME_WORD =
  /(?<![\p{L}])(?:[وبل]?اسم(?:كم|ك)|و?اسم حضرتك|[وبل]?(?:ال|لل)اسم|اسمين|your (?:full |first |last )?name|full name)(?![\p{L}])/iu
const unmarked = (text: string) => text.replace(/[ً-ْـ]/g, '').replace(/[أإآٱ]/g, 'ا')
const isAboutName = (sentence: string) => !sentence.includes(SAVED_NAME_PLACEHOLDER) && NAME_WORD.test(unmarked(sentence))

/** The model's text talks about the visitor's name (other than quoting it from the record) */
export function mentionsName(template: string) {
  return template.split(SENTENCE_END).some(isAboutName)
}

/**
 * The next thing the booking still needs, asked by code: the phone number,
 * then the day and time. The branch is not asked for here: until a client's
 * branches are data (the branches table) code cannot know whether it has one
 * branch or several, and "which branch?" to a business with one is a new
 * defect.
 */
function nextQuestion(known: Known, language: ReplyLanguage) {
  if (!known.phone && !known.phoneGivenUp) return TEXTS[language].phoneAsk
  if (!known.time) return (language === 'ar' ? ar : en).botReplies.appointment.askTime
  return ''
}

export function composeReply({
  template,
  outcome,
  events,
  record,
  visitorMessages,
  language,
  appointmentDecided = false,
  otherAnswer = null,
  known,
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
  /**
   * Code decided something about the appointment on this message (the
   * outcome is what): the model reported one, or a time held from earlier was
   * booked or refused (confirmPending) with nothing reported
   */
  appointmentDecided?: boolean
  /** The model's answer to whatever the message asked besides the appointment: all of its text that is sent when code decided */
  otherAnswer?: string | null
  /** Without it the model's questions are not checked against what code holds */
  known?: Known
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

  // ONE RULE, in both directions: on any turn where code decides something
  // about the appointment, code writes everything the visitor is told about
  // it (appointmentLine) and the model's reply is not sent. What the model
  // may add is its answer to something else the same message asked, which it
  // writes in a field of its own. That covers the turn where the model
  // reported nothing and a time held from earlier was booked or refused: the
  // model's reply on that turn was written without knowing either.
  //
  // Two narrower rules came first and both failed, because both asked the
  // model's output what the model's text meant: that a reply without the
  // placeholder was written against the booking, and that a request flagged
  // needs_team_check was. GT07, 13 October 2026: a refusal that ended on the
  // placeholder, with no flag, sent as "…خارج مواعيد العمل… موعدك مؤكَّد ✅".
  const said = appointmentDecided ? (otherAnswer ?? '') : template

  // Code has the visitor's name, as given, and is not asking for it again;
  // the model, told so, asks all the same when the business's own prompt
  // demands a fuller name. Seen in the eval on 13 October 2026 (NM01): "م"
  // accepted and flagged, and "محتاج اسمك بالكامل لو سمحت" sent on that turn
  // and the one after — the loop the single re-ask exists to prevent, in the
  // text the visitor reads. What the model says about the name goes; the
  // visitor is greeted by the name they gave and asked for the next thing the
  // booking needs. They are never told the name was short of a full one: the
  // flag is for the team.
  const nameSettled = Boolean(known?.name) && mentionsName(said)
  const sentences = said.split(SENTENCE_END)
  const text = nameSettled
    ? sentences
        .filter((sentence) => !isAboutName(sentence))
        .join('')
        .trim()
    : said

  const rendered = appointmentDecided
    ? [
        // The answer to the other question; a sentence that quotes the appointment is the system's to write
        text
          .split(SENTENCE_END)
          .filter((sentence) => !sentence.includes(APPOINTMENT_PLACEHOLDER))
          .join('')
          .trim(),
        appointmentLine(outcome, language),
      ]
        .filter(Boolean)
        .join('\n')
    : renderReply(text, outcome, language).trim()
  const reply = withoutUnsavedNumbers(renderSaved(rendered, record, language), record, visitorMessages, language)
  // The appointment's own sentence opens with "تمام": no second one before it
  if (!nameSettled || !known?.name || outcome.status === 'booked') return reply

  const greeting = t.nameAck.replace('{name}', known.name.split(' ')[0])
  // A question the model asked about something else, or what code says of
  // the booking, already moves the conversation on
  const movesOn = /[?؟]/.test(reply) || outcome.status !== 'none'
  return [greeting, reply, movesOn ? '' : nextQuestion(known, language)].filter(Boolean).join('\n')
}
