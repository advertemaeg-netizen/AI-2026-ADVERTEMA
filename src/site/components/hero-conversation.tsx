'use client'

import { useSyncExternalStore } from 'react'
import { BrandLockup } from '@/components/brand'
import { demoSlotText, type ClockWords } from '@/site/demo-slot'

/**
 * The hero's conversation: six lines, played once. The visitor's three are
 * the copy owner's (messages/site); the bot's three are the product's own
 * sentences, word for word (messages/{ar,en}.json, passed in by the page),
 * in the booking order AFTER the booking-order fix: the time first, then the
 * name, then the number, one at a time. That fix has to ship before the site
 * goes public, or this shows an order the bot doesn't follow yet.
 *
 * The appointment's date is worked out when the page loads, so it is always
 * tomorrow; the static HTML carries the build day's date until then.
 */

export type BotTemplates = {
  /** "عشان أثبّت الحجز يوم {time} محتاج {missing}." */
  needDetails: string
  missingName: string
  phoneAsk: string
  /** "تمام — موعدك {time} ✅" */
  bookedConfirmed: string
  words: ClockWords
}

// The page's load time, read once: the snapshot must not change between renders
let loadedAt: string | null = null
const clientNow = () => (loadedAt ??= new Date().toISOString())
const noSubscription = () => () => {}

// When each line arrives (ms), and the typing dots before each bot line. One cycle, then it stays.
const AT = [600, 2300, 3900, 5500, 7100, 8700]
const TYPING_AT = [1300, 4600, 7800]

export function HeroConversation({
  language,
  label,
  visitor,
  bot,
  builtAt,
}: {
  language: 'ar' | 'en'
  /** The caption, «محادثة حقيقية من مُدرك» */
  label: string
  /** The visitor's three lines, in order (the copy's messages 0, 2 and 4) */
  visitor: string[]
  bot: BotTemplates
  /** The build's time: what the HTML shows before the page has loaded */
  builtAt: string
}) {
  // The build's time while rendering on the server and hydrating, the visitor's own once in the browser
  const now = useSyncExternalStore(noSubscription, clientNow, () => builtAt)
  const time = demoSlotText(new Date(now), language, bot.words)
  const lines = [
    { from: 'visitor', text: visitor[0] },
    { from: 'bot', text: bot.needDetails.replace('{time}', time).replace('{missing}', bot.missingName) },
    { from: 'visitor', text: visitor[1] },
    { from: 'bot', text: bot.phoneAsk },
    { from: 'visitor', text: visitor[2] },
    { from: 'bot', text: bot.bookedConfirmed.replace('{time}', time) },
  ]
  let botIndex = -1
  return (
    <figure className="site-phone site-convo mx-auto w-full max-w-md p-5">
      <figcaption className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
        <BrandLockup height={22} />
        <span className="text-sm">{label}</span>
      </figcaption>
      <ol className="flex flex-col gap-3 text-[0.95rem]">
        {lines.map((line, i) => {
          const typing = line.from === 'bot' ? TYPING_AT[++botIndex] : undefined
          return (
            // The typing dots and the reply share one grid cell: the dots fade out where the
            // answer fades in, so nothing shifts and nothing is left taking up space
            <li key={i} className={`grid ${line.from === 'visitor' ? 'justify-items-end' : 'justify-items-start'}`}>
              {typing !== undefined && (
                <span
                  data-typing
                  aria-hidden
                  className="col-start-1 row-start-1 gap-1 self-start rounded-full bg-white px-3 py-2.5"
                  style={{ '--at': typing } as React.CSSProperties}
                >
                  {[0, 1, 2].map((d) => (
                    <span key={d} className="size-1.5 rounded-full bg-primary/50" style={{ '--i': d, '--at': typing } as React.CSSProperties} />
                  ))}
                </span>
              )}
              <p
                data-step
                {...(i === lines.length - 1 ? { 'data-confirm': '' } : {})}
                data-from={line.from}
                className="site-bubble col-start-1 row-start-1"
                style={{ '--at': AT[i] } as React.CSSProperties}
              >
                {line.text}
              </p>
            </li>
          )
        })}
      </ol>
    </figure>
  )
}
