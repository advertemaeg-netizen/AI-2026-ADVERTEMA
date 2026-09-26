'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { AlertTriangle, Bug, ChevronDown, RotateCcw, SendHorizontal, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { testBot } from '@/lib/actions/playground'
import type { BotDebug } from '@/lib/ai/bot'
import type { BotSettingsInput } from '@/lib/types/bot-settings'
import { PLAYGROUND_MAX_MESSAGE_LENGTH, type PlaygroundError } from '@/lib/types/playground'

type ChatItem =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'assistant'; content: string; debug?: BotDebug }
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
  /** Narrow column (settings preview): debug panel goes under the chat */
  compact?: boolean
}) {
  const t = useTranslations('playground')
  const [items, setItems] = useState<ChatItem[]>([])
  const [draft, setDraft] = useState('')
  const [showDebug, setShowDebug] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [items.length, isPending])

  const replies = items.filter((item) => item.role === 'assistant')
  const selected = replies.find((item) => item.id === selectedId) ?? replies.at(-1)

  function send(e?: React.FormEvent) {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || isPending) return

    const userItem: ChatItem = { id: crypto.randomUUID(), role: 'user', content: text }
    const next = [...items, userItem]
    setItems(next)
    setDraft('')

    // Full conversation so far — errors are UI-only and never sent
    const history = next.flatMap((item) =>
      item.role === 'error' ? [] : [{ role: item.role, content: item.content }]
    )

    startTransition(async () => {
      // Debug is always requested so the panel works for earlier replies too
      const result = await testBot(clientId, history, true, getSettingsOverride?.())
      const id = crypto.randomUUID()
      if (result.ok) {
        setItems((prev) => [...prev, { id, role: 'assistant', content: result.reply, debug: result.debug }])
        setSelectedId(id)
      } else {
        setItems((prev) => [...prev, { id, role: 'error', error: result.error }])
      }
      inputRef.current?.focus()
    })
  }

  function reset() {
    setItems([])
    setSelectedId(null)
    setDraft('')
    inputRef.current?.focus()
  }

  return (
    <div className={cn('grid gap-4', showDebug && !compact && 'xl:grid-cols-[minmax(0,1fr)_420px]')}>
      <Card
        className={cn(
          'flex min-h-[480px] flex-col gap-0 overflow-hidden py-0',
          compact ? 'h-[calc(100vh-10rem)]' : 'h-[calc(100vh-18rem)]'
        )}
      >
        <div className="flex items-center justify-between gap-3 bg-gradient-to-br from-purple-500 to-orange-500 px-4 py-3 text-white">
          <div className="flex min-w-0 items-center gap-2">
            <Sparkles className="size-4 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{clientName}</p>
              <p className="text-xs opacity-85">{t('localOnly')}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <Switch checked={showDebug} onCheckedChange={setShowDebug} />
              <span className={cn('hidden', !compact && 'sm:inline')}>{t('showDebug')}</span>
              <Bug className={cn('size-4', !compact && 'sm:hidden')} aria-label={t('showDebug')} />
            </label>
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
              const isSelected = showDebug && selected?.id === item.id
              return (
                <Bubble
                  key={item.id}
                  role="assistant"
                  onSelect={showDebug ? () => setSelectedId(item.id) : undefined}
                  selected={isSelected}
                  selectLabel={t('debug.selectReply')}
                >
                  {item.content}
                </Bubble>
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

      {showDebug && <DebugPanel debug={selected?.role === 'assistant' ? selected.debug : undefined} />}
    </div>
  )
}

function Bubble({
  role,
  children,
  onSelect,
  selected,
  selectLabel,
}: {
  role: 'user' | 'assistant'
  children: React.ReactNode
  onSelect?: () => void
  selected?: boolean
  selectLabel?: string
}) {
  const className = cn(
    'max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm text-start',
    role === 'user'
      ? 'self-end rounded-se-sm bg-gradient-to-br from-purple-500 to-orange-500 text-white'
      : 'self-start rounded-ss-sm border bg-background',
    selected && 'ring-2 ring-primary'
  )

  if (onSelect) {
    return (
      <button type="button" className={cn(className, 'cursor-pointer hover:bg-muted')} onClick={onSelect} aria-pressed={selected} title={selectLabel}>
        {children}
      </button>
    )
  }
  return <div className={className}>{children}</div>
}

function DebugPanel({ debug }: { debug?: BotDebug }) {
  const t = useTranslations('playground.debug')
  const format = useFormatter()

  return (
    <Card size="sm" className="h-fit">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bug className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{debug ? t('description') : t('empty')}</CardDescription>
      </CardHeader>

      {debug && (
        <CardContent>
          <Tabs defaultValue="chunks">
            <TabsList className="w-full">
              <TabsTrigger value="chunks">
                {t('tabs.chunks')}
                <Badge variant="secondary">{debug.chunks.filter((c) => c.used).length}</Badge>
              </TabsTrigger>
              <TabsTrigger value="prompt">{t('tabs.prompt')}</TabsTrigger>
              <TabsTrigger value="timing">{t('tabs.timing')}</TabsTrigger>
            </TabsList>

            <TabsContent value="chunks" className="mt-3 grid gap-2">
              {debug.retrievalError && (
                <p className="flex items-center gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                  <AlertTriangle className="size-4 shrink-0" />
                  {t('retrievalError')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('thresholdNote', { threshold: debug.threshold })}
              </p>
              {debug.chunks.length === 0 && !debug.retrievalError && (
                <p className="py-4 text-center text-sm text-muted-foreground">{t('noChunks')}</p>
              )}
              {debug.chunks.map((chunk) => (
                <Collapsible key={chunk.id} className="rounded-lg border">
                  <CollapsibleTrigger className="group flex w-full items-center gap-2 p-2.5 text-start text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{chunk.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('chunkIndex', { index: chunk.chunk_index + 1 })}
                      </p>
                    </div>
                    <Badge variant="outline" className="font-mono" dir="ltr">
                      {format.number(chunk.similarity, { maximumFractionDigits: 3, minimumFractionDigits: 3 })}
                    </Badge>
                    <Badge
                      variant="secondary"
                      className={
                        chunk.used
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'text-muted-foreground'
                      }
                    >
                      {chunk.used ? t('used') : t('notUsed')}
                    </Badge>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <p className="border-t p-2.5 text-xs whitespace-pre-wrap text-muted-foreground">
                      {chunk.content}
                    </p>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </TabsContent>

            <TabsContent value="prompt" className="mt-3 grid gap-3">
              <section className="grid gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t('systemPrompt')}</h3>
                <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                  {debug.systemPrompt}
                </pre>
              </section>
              <section className="grid gap-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">
                  {t('conversation', { count: debug.contents.length })}
                </h3>
                <div className="grid max-h-80 gap-1.5 overflow-auto rounded-lg bg-muted p-3 text-xs">
                  {debug.contents.map((content, i) => (
                    <p key={i} className="whitespace-pre-wrap break-words">
                      <span className="font-mono font-semibold" dir="ltr">
                        {content.role}:
                      </span>{' '}
                      {content.parts.map((part) => part.text).join('')}
                    </p>
                  ))}
                </div>
              </section>
            </TabsContent>

            <TabsContent value="timing" className="mt-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('timing.embedding')}</dt>
                <dd className="font-mono" dir="ltr">{debug.timings.embeddingMs} ms</dd>
                <dt className="text-muted-foreground">{t('timing.retrieval')}</dt>
                <dd className="font-mono" dir="ltr">{debug.timings.retrievalMs} ms</dd>
                <dt className="text-muted-foreground">{t('timing.generation')}</dt>
                <dd className="font-mono" dir="ltr">{debug.timings.generationMs} ms</dd>
                <dt className="font-medium">{t('timing.total')}</dt>
                <dd className="font-mono font-medium" dir="ltr">{debug.timings.totalMs} ms</dd>
                <dt className="text-muted-foreground">{t('timing.model')}</dt>
                <dd className="font-mono text-xs" dir="ltr">{debug.model}</dd>
              </dl>
            </TabsContent>
          </Tabs>
        </CardContent>
      )}
    </Card>
  )
}
