'use client'

import { Fragment, useEffect, useRef, useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { RotateCcw, SendHorizontal, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { testBot } from '@/lib/actions/playground'
import type { BotSettingsInput } from '@/lib/types/bot-settings'
import {
  PLAYGROUND_MAX_MESSAGE_LENGTH,
  type PlaygroundError,
  type PlaygroundMessage,
  type PlaygroundState,
} from '@/lib/types/playground'

type ChatItem =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; metadata: Record<string, unknown> | null; simulatedAppointment?: string }
  | { id: string; role: 'error'; error: PlaygroundError }

export function Playground({
  clientId,
  clientName,
  welcomeMessage,
  getSettingsOverride,
  compact = false,
}: {
  clientId: string
  clientName: string
  welcomeMessage: string
  /** Bot settings preview: called on each send to use unsaved form values */
  getSettingsOverride?: () => BotSettingsInput
  /** Narrow column (settings preview) */
  compact?: boolean
}) {
  const t = useTranslations('playground')
  const format = useFormatter()
  const [items, setItems] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  // What the chat would have written (its lead rows): nothing is stored, so the browser carries it
  const [state, setState] = useState<PlaygroundState>()
  const [isPending, startTransition] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [items.length, isPending])

  function send(e?: React.FormEvent) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || isPending) return

    const userItem: ChatItem = { id: crypto.randomUUID(), role: 'user', content: text }
    const next = [...items, userItem]
    setItems(next)
    setDraft('')

    // Full conversation so far, each reply with its trace — errors are UI-only and never sent
    const history = next.flatMap((item): PlaygroundMessage[] =>
      item.role === 'error'
        ? []
        : item.role === 'assistant'
          ? [{ role: item.role, content: item.content, metadata: item.metadata }]
          : [{ role: item.role, content: item.content }]
    )

    startTransition(async () => {
      const result = await testBot(clientId, history, getSettingsOverride?.(), state)
      const id = crypto.randomUUID()
      if (result.ok) {
        setState(result.state)
        setItems((prev) => [
          ...prev,
          {
            id,
            role: 'assistant',
            content: result.reply,
            metadata: result.metadata,
            simulatedAppointment: result.simulatedAppointment,
          },
        ])
      } else {
        setItems((prev) => [...prev, { id, role: 'error', error: result.error }])
      }
      inputRef.current?.focus()
    })
  }

  function reset() {
    setItems([])
    setState(undefined)
    setDraft('')
    inputRef.current?.focus()
  }

  return (
    <Card
      className={cn(
        'flex min-h-[480px] flex-col gap-0 overflow-hidden py-0',
        compact ? 'h-[calc(100vh-10rem)]' : 'h-[calc(100vh-18rem)]'
      )}
    >
      <div className="flex items-center justify-between gap-3 bg-primary px-4 py-3 text-primary-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-4 shrink-0" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{clientName}</p>
            <p className="text-xs opacity-85">{t('localOnly')}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={reset}
          disabled={items.length === 0 || isPending}
        >
          <RotateCcw data-icon="inline-start" />
          <span className={cn(compact && 'sr-only')}>{t('newConversation')}</span>
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 bg-muted/30">
        <div className="flex flex-col gap-2 p-4" role="log" aria-live="polite">
          <Bubble role="assistant">{welcomeMessage}</Bubble>

          {items.map((item) => {
            if (item.role === 'error') {
              return (
                <p
                  key={item.id}
                  className="self-center rounded-lg bg-destructive/10 px-3 py-1.5 text-center text-xs text-destructive"
                >
                  {t(`errors.${item.error}`)}
                </p>
              )
            }
            if (item.role === 'user') {
              return (
                <Bubble key={item.id} role="user">
                  {item.content}
                </Bubble>
              )
            }
            return (
              <Fragment key={item.id}>
                <Bubble role="assistant">{item.content}</Bubble>
                {/* The reply reads as a booking; nothing was stored */}
                {item.simulatedAppointment && (
                  <p className="max-w-[85%] self-start rounded-md border border-dashed border-warning-solid/60 bg-warning-solid/10 px-3 py-1.5 text-xs text-warning">
                    {t('simulatedAppointment', {
                      time: format.dateTime(new Date(item.simulatedAppointment), {
                        dateStyle: 'full',
                        timeStyle: 'short',
                        timeZone: 'Africa/Cairo',
                      }),
                    })}
                  </p>
                )}
              </Fragment>
            )
          })}

          {isPending && (
            <div
              className="flex gap-1 self-start rounded-2xl rounded-ss-sm border bg-background px-3.5 py-3"
              aria-label={t('typing')}
            >
              {[0, 150, 300].map((delay) => (
                <span
                  key={delay}
                  className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
                  style={{ animationDelay: `${delay}ms` }}
                />
              ))}
            </div>
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <form onSubmit={send} className="flex gap-2 border-t bg-background p-3">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          maxLength={PLAYGROUND_MAX_MESSAGE_LENGTH}
          autoFocus
        />
        <Button type="submit" disabled={!draft.trim() || isPending} aria-label={t('send')}>
          <SendHorizontal className="rtl:rotate-180" />
        </Button>
      </form>
    </Card>
  )
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm text-start',
        role === 'user'
          ? 'self-end rounded-se-sm bg-primary text-primary-foreground'
          : 'self-start rounded-ss-sm border bg-background'
      )}
    >
      {children}
    </div>
  )
}
