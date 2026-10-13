import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import { composeReply } from '@/lib/ai/compose'
import { describeContact, EMPTY_CONTACT, readContact, validateName, type ContactState } from '@/lib/ai/contact'
import { displayPhone, normalizePhone, telHref, whatsappHref } from '@/lib/phone'

const T = ar.botReplies.contact

describe('one stored phone format: E.164', () => {
  it.each([
    ['01003462718'],
    ['201003462718'],
    ['+201003462718'],
    ['00201003462718'],
    ['0100 346 2718'],
    ['010-0346-2718'],
    ['(+20) 100 346 2718'],
    ['٠١٠٠٣٤٦٢٧١٨'],
  ])('reads %s as the same Egyptian mobile', (typed) => {
    expect(normalizePhone(typed)).toBe('+201003462718')
  })

  it('takes every Egyptian mobile prefix, and no other', () => {
    expect(['010', '011', '012', '015'].map((prefix) => normalizePhone(`${prefix}12345678`))).toEqual([
      '+201012345678',
      '+201112345678',
      '+201212345678',
      '+201512345678',
    ])
    expect(normalizePhone('01312345678')).toBeNull()
  })

  it('takes a number of another country written internationally', () => {
    expect(normalizePhone('+966 50 123 4567')).toBe('+966501234567')
    expect(normalizePhone('00971501234567')).toBe('+971501234567')
  })

  it.each([
    ['the number sent on the demo widget', '879995233130'],
    ['a foreign number without its +', '966501234567'],
    ['an Egyptian landline', '0225201184'],
    ['an Egyptian landline with +20', '+20225201184'],
    ['ten digits, the leading zero missing', '1003462718'],
    ['too short', '010'],
    ['too long', '010546845464131546'],
    ['an international number that is too short', '+1234567'],
    ['nothing', ''],
  ])('refuses %s', (_name, typed) => {
    expect(normalizePhone(typed)).toBeNull()
  })

  it('shows an Egyptian mobile the way it is dialled, and a foreign number as stored', () => {
    expect(displayPhone('+201003462718')).toBe('01003462718')
    expect(displayPhone('+966501234567')).toBe('+966501234567')
    // A row from before E.164
    expect(displayPhone('01003462718')).toBe('01003462718')
  })

  // The sidebar link once read wa.me/20+201003462718: "20" put in front of a
  // number that already carried "+20"
  it('builds the WhatsApp link from the digits alone', () => {
    expect(whatsappHref('+201003462718')).toBe('https://wa.me/201003462718')
    expect(whatsappHref('+966501234567')).toBe('https://wa.me/966501234567')
    // A row from before E.164 still gets its country code, once
    expect(whatsappHref('01003462718')).toBe('https://wa.me/201003462718')
    expect(telHref('+201003462718')).toBe('tel:+201003462718')
    expect(telHref('01003462718')).toBe('tel:+201003462718')
  })
})

describe('a full name', () => {
  it.each([['كريم مصطفى'], ['هدى عبد العظيم'], ['Karim  Mostafa'], ["Jean-Paul O'Neil"], ['مُحمَّد علي']])('accepts %s', (name) => {
    expect(validateName(name)).toBe(name.replace(/\s+/g, ' '))
  })

  it.each([['one word', 'سامح'], ['one letter', 'م'], ['a one-letter word', 'محمد ع'], ['digits', 'كريم 123'], ['a number', '01012345678'], ['nothing', '']])(
    'refuses %s',
    (_name, value) => {
      expect(validateName(value)).toBeNull()
    }
  )
})

/** The visitor's messages in turn, each with what the model reported for it */
function converse(turns: [message: string, report: { name?: string; phone?: string } | null][]) {
  let state: ContactState = EMPTY_CONTACT
  const said: string[] = []
  const events = turns.map(([message, report]) => {
    said.push(message)
    const read = readContact(state, report, message, said)
    state = read.state
    return read.events
  })
  return { state, events }
}

describe('the name and number a conversation establishes', () => {
  it('stores a valid number from the message itself, whatever the model reported', () => {
    expect(converse([['موبايلي 0100 284 7901', null]])).toMatchObject({
      state: { phone: '+201002847901', phoneRejections: 0 },
      events: [{ phone: 'stored' }],
    })
  })

  // The demo widget, 12 October 2026: "010", then "9856546", then "879995233130"
  it('rejects a number that is not one, and stops asking after the second', () => {
    const { state, events } = converse([
      ['010', { phone: '010' }],
      ['9856546', { phone: '9856546' }],
      ['879995233130', { phone: '879995233130' }],
    ])
    expect(events.map((e) => e.phone)).toEqual(['rejected', 'rejected_final', 'rejected_final'])
    expect(state.phone).toBeNull()
  })

  it('rejects a bare number even when the model reports nothing', () => {
    expect(converse([['879995233130', null]]).events[0].phone).toBe('rejected')
  })

  it('leaves a sum, a date and a price alone', () => {
    const { state, events } = converse([
      ['1900-500+200', null],
      ['13-10-2026', null],
      ['عايز 10 عدسات، بكام الحالة كلها؟', null],
    ])
    expect(events.map((e) => e.phone)).toEqual(['none', 'none', 'none'])
    expect(state.phoneRejections).toBe(0)
  })

  it('keeps the number already stored when a later one is not valid', () => {
    const { state, events } = converse([
      ['01002847901', null],
      ['879995233130', null],
    ])
    expect(events[1].phone).toBe('rejected')
    expect(state.phone).toBe('+201002847901')
  })

  it('stores a full name', () => {
    expect(converse([['أنا كريم سامي', { name: 'كريم سامي' }]])).toMatchObject({
      state: { name: 'كريم سامي', nameIncomplete: false },
      events: [{ name: 'stored' }],
    })
  })

  it('asks once about a name that is not a full name, then accepts what was given and flags it', () => {
    const { state, events } = converse([
      ['اسمي م', { name: 'م' }],
      ['م', { name: 'م' }],
    ])
    expect(events.map((e) => e.name)).toEqual(['ask_again', 'stored_incomplete'])
    expect(state).toMatchObject({ name: 'م', nameIncomplete: true, pendingName: null })
  })

  it('accepts the name on the next message whatever that message is about', () => {
    const { state, events } = converse([
      ['أنا سامح', { name: 'سامح' }],
      ['والتأمين بيغطي؟', null],
    ])
    expect(events.map((e) => e.name)).toEqual(['ask_again', 'stored_incomplete'])
    expect(state).toMatchObject({ name: 'سامح', nameIncomplete: true })
  })

  it('takes the full name when the re-ask gets one, with no flag', () => {
    const { state, events } = converse([
      ['أنا سامح', { name: 'سامح' }],
      ['سامح عبد الله', { name: 'سامح عبد الله' }],
    ])
    expect(events.map((e) => e.name)).toEqual(['ask_again', 'stored'])
    expect(state).toMatchObject({ name: 'سامح عبد الله', nameIncomplete: false })
  })

  it('never asks a second time', () => {
    const { events } = converse([
      ['أنا سامح', { name: 'سامح' }],
      ['سامح', { name: 'سامح' }],
      ['سامح', { name: 'سامح' }],
      ['قلتلك سامح', { name: 'سامح' }],
    ])
    expect(events.filter((e) => e.name === 'ask_again')).toHaveLength(1)
  })

  it('drops a name the visitor never wrote: the model reports, it does not supply', () => {
    expect(converse([['عايز أحجز', { name: 'كريم مصطفى' }]])).toMatchObject({
      state: { name: null, pendingName: null },
      events: [{ name: 'none' }],
    })
  })

  it('finds the name the model copied with a tidied spelling', () => {
    expect(converse([['انا احمد علي', { name: 'أحمد علي' }]]).state.name).toBe('أحمد علي')
  })
})

describe('the reply states only what is on record', () => {
  const none = { status: 'none' } as const
  const quiet = { name: 'none', phone: 'none' } as const
  const compose = (over: Partial<Parameters<typeof composeReply>[0]>) =>
    composeReply({
      template: '',
      outcome: none,
      events: quiet,
      record: { name: null, phone: null },
      visitorMessages: [],
      language: 'ar',
      ...over,
    })

  // The demo widget, 12 October 2026: "تمام يا م، رقمك وصل" to 879995233130
  it('replaces the model\'s reply when the number was rejected, and says what is wrong', () => {
    const reply = compose({
      template: 'تمام يا م، رقمك وصل. تحب تحجز في فرع المعادي ولا التجمع؟',
      events: { name: 'none', phone: 'rejected' },
      visitorMessages: ['879995233130'],
    })
    expect(reply).toBe(T.phoneInvalid)
    expect(reply).toContain('11 رقم ويبدأ بـ 01')
  })

  it('stops asking after the second rejected number, and hands it to the team', () => {
    expect(compose({ template: 'تمام، رقمك وصل.', events: { name: 'none', phone: 'rejected_final' } })).toBe(T.phoneGiveUp)
  })

  it('asks for the full name instead of the model\'s reply', () => {
    expect(compose({ template: 'تمام يا م 😊 ممكن رقم موبايلك؟', events: { name: 'ask_again', phone: 'none' } })).toBe(T.nameAsk)
  })

  it('fills {{saved_phone}} from the record, in the form it is dialled', () => {
    expect(compose({ template: 'أيوه، رقمك عندنا {{saved_phone}}.', record: { name: 'كريم سامي', phone: '+201002847901' } })).toBe(
      'أيوه، رقمك عندنا 01002847901.'
    )
  })

  it('says nothing is on record when the placeholder has nothing to quote', () => {
    expect(compose({ template: 'أيوه، رقمك عندنا {{saved_phone}}. تحب أساعدك بحاجة تانية؟' })).toBe(
      `${T.noPhoneOnRecord} تحب أساعدك بحاجة تانية؟`
    )
    expect(compose({ template: 'اسمك عندنا {{saved_name}}.' })).toBe(T.noNameOnRecord)
  })

  // The demo widget, 12 October 2026: asked "سجلت رقم تليفوني؟" while phone was null
  it('removes a number read back from the chat that is not the one on record', () => {
    const reply = compose({
      template: 'أيوه، الرقم اللي بعتّه هو 879995233130. بس للتوضيح، الفريق هيأكدلك الميعاد.',
      visitorMessages: ['879995233130', 'سجلت رقم تليفوني ؟'],
    })
    expect(reply).not.toContain('879995233130')
    expect(reply).toBe(`بس للتوضيح، الفريق هيأكدلك الميعاد.\n${T.noPhoneOnRecord}`)
  })

  it('states the number on record in place of another one the visitor had sent', () => {
    const reply = compose({
      template: 'رقمك 879995233130 متسجل.',
      record: { name: null, phone: '+201097365130' },
      visitorMessages: ['879995233130', '01097365130'],
    })
    expect(reply).toBe(T.phoneOnRecord.replace('{phone}', '01097365130'))
  })

  it('leaves the number on record, and the business\'s own numbers, alone', () => {
    const template = 'رقمك 01097365130. للطوارئ اتصل على 01002847562 أو 02-25201184.'
    expect(compose({ template, record: { name: null, phone: '+201097365130' }, visitorMessages: ['01097365130'] })).toBe(template)
  })
})

describe('what the model is told about the record', () => {
  it('names what is on record, so it is not asked for again', () => {
    const told = describeContact({ ...EMPTY_CONTACT, name: 'كريم سامي', phone: '+201002847901' })
    expect(told).toContain("name is on record: don't ask")
    expect(told).toContain("phone number is on record: don't ask")
    // The values themselves stay out of the prompt: the reply quotes them through placeholders
    expect(told).not.toContain('01002847901')
    expect(told).not.toContain('كريم')
  })

  it('tells the model to stop asking for the phone once the system has', () => {
    expect(describeContact({ ...EMPTY_CONTACT, phoneRejections: 2 })).toContain('do NOT ask for a phone number again')
    expect(describeContact({ ...EMPTY_CONTACT, phoneRejections: 1 })).toContain('not on record yet')
  })

  it('tells the model the name was asked about once', () => {
    expect(describeContact({ ...EMPTY_CONTACT, pendingName: 'سامح' })).toContain("don't ask for it again, whatever they answer")
  })
})
