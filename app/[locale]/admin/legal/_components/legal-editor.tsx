'use client'

import { Fragment, useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { LegalMarkdown } from '@/components/legal-markdown'
import { publishLegalVersion, type AdminLegalVersion } from '@/lib/actions/legal'
import { LEGAL_DOCUMENTS, type LegalDocument, type LegalLocale } from '@/lib/legal'
import { lineDiff } from '@/lib/line-diff'
import { cn } from '@/lib/utils'

const LOCALES: LegalLocale[] = ['ar', 'en']

/**
 * The legal documents' editor: the two documents, each with its Arabic and
 * English side by side (two texts, two histories). A publish is a new version
 * and the public text at once, so it asks first, and only when something
 * changed; nothing here edits or removes a version. Earlier versions are read
 * here only: the public site shows the current version alone.
 */
export function LegalEditor({ versions }: { versions: AdminLegalVersion[] }) {
  const t = useTranslations('admin.legal')
  return (
    <Tabs defaultValue="privacy" className="grid gap-4">
      <TabsList>
        {LEGAL_DOCUMENTS.map((document) => (
          <TabsTrigger key={document} value={document}>
            {t(document)}
          </TabsTrigger>
        ))}
      </TabsList>
      {LEGAL_DOCUMENTS.map((document) => (
        <TabsContent key={document} value={document} className="grid gap-6">
          <div className="grid gap-6 lg:grid-cols-2">
            {LOCALES.map((locale) => {
              const history = versions.filter((v) => v.document === document && v.locale === locale)
              return <DocumentColumn key={locale} document={document} locale={locale} current={history[0] ?? null} />
            })}
          </div>
          <History versions={versions.filter((v) => v.document === document)} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

function DocumentColumn({ document, locale, current }: { document: LegalDocument; locale: LegalLocale; current: AdminLegalVersion | null }) {
  const t = useTranslations('admin.legal')
  const format = useFormatter()
  const router = useRouter()
  const [title, setTitle] = useState(current?.title ?? '')
  const [body, setBody] = useState(current?.body ?? '')
  const [note, setNote] = useState('')
  const [view, setView] = useState<'edit' | 'preview' | 'changes'>('edit')
  const [confirming, setConfirming] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const changed = title.trim() !== (current?.title ?? '') || body.trim() !== (current?.body ?? '')
  const next = (current?.version ?? 0) + 1
  const dir = locale === 'ar' ? 'rtl' : 'ltr'
  const id = (field: string) => `legal-${document}-${locale}-${field}`

  function publish() {
    startTransition(async () => {
      const result = await publishLegalVersion({ document, locale, title, body, note })
      setConfirming(false)
      if (result.ok) {
        setNote('')
        setMessage({ ok: true, text: t('published', { version: result.version }) })
        router.refresh()
      } else {
        setMessage({ ok: false, text: t(`error.${result.error}`) })
      }
    })
  }

  return (
    <section className="grid content-start gap-4 rounded-xl border border-border bg-card p-4 md:p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t(locale === 'ar' ? 'arabic' : 'english')}</h2>
        {current && (
          <span className="text-sm text-muted-foreground">
            {t('current', { version: current.version, date: format.dateTime(new Date(current.created_at), { dateStyle: 'medium' }) })}
          </span>
        )}
      </header>

      <div className="grid gap-1.5">
        <Label htmlFor={id('title')}>{t('fieldTitle')}</Label>
        <Input id={id('title')} dir={dir} lang={locale} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="flex gap-1" role="group" aria-label={t('fieldBody')}>
        {(['edit', 'preview', 'changes'] as const).map((mode) => (
          <Button key={mode} type="button" size="sm" variant={view === mode ? 'default' : 'outline'} aria-pressed={view === mode} onClick={() => setView(mode)}>
            {t(mode)}
          </Button>
        ))}
      </div>

      {view === 'edit' && (
        <div className="grid gap-1.5">
          <Label htmlFor={id('body')}>{t('fieldBody')}</Label>
          <Textarea id={id('body')} dir={dir} lang={locale} value={body} onChange={(e) => setBody(e.target.value)} className="min-h-[60vh] font-mono text-sm leading-relaxed" />
        </div>
      )}
      {view === 'preview' && (
        <div dir={dir} lang={locale} className="grid max-h-[60vh] gap-4 overflow-y-auto rounded-lg border border-border p-4">
          <h1 className="text-2xl font-bold">{title}</h1>
          <LegalMarkdown text={body} headingClassName="text-lg font-bold" />
        </div>
      )}
      {view === 'changes' && <Changes before={current ? `${current.title}\n\n${current.body}` : ''} after={`${title.trim()}\n\n${body.trim()}`} dir={dir} />}

      <div className="grid gap-1.5">
        <Label htmlFor={id('note')}>{t('fieldNote')}</Label>
        <Input id={id('note')} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>

      {confirming ? (
        <div role="alertdialog" aria-labelledby={id('confirm')} className="grid gap-3 rounded-lg border border-warning-solid bg-warning-solid/10 p-3">
          <p id={id('confirm')} className="text-sm font-medium">
            {t('confirm')}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={publish} disabled={pending}>
              {t('confirmPublish')}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" className="justify-self-start" disabled={!changed || pending} onClick={() => (setMessage(null), setConfirming(true))}>
          {t('publish', { version: next })}
        </Button>
      )}
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={cn('text-sm', message.ok ? 'text-positive' : 'text-destructive')}>
          {message.text}
        </p>
      )}
    </section>
  )
}

function Changes({ before, after, dir }: { before: string; after: string; dir: 'rtl' | 'ltr' }) {
  const t = useTranslations('admin.legal')
  const lines = lineDiff(before, after)
  if (lines.every((line) => line.kind === 'same')) return <p className="text-sm text-muted-foreground">{t('noChanges')}</p>
  return (
    <pre dir={dir} className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-lg border border-border p-3 font-mono text-xs leading-relaxed">
      {lines
        .filter((line, i, all) => line.kind !== 'same' || all[i - 1]?.kind !== 'same' || all[i + 1]?.kind !== 'same')
        .map((line, i) => (
          <div key={i} className={cn(line.kind === 'added' && 'bg-positive/15', line.kind === 'removed' && 'bg-destructive/15 line-through')}>
            {line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '− ' : '  '}
            {line.text}
          </div>
        ))}
    </pre>
  )
}

/** Every version, each readable in place: the public site has no address for an earlier one */
function History({ versions }: { versions: AdminLegalVersion[] }) {
  const t = useTranslations('admin.legal')
  const format = useFormatter()
  const [open, setOpen] = useState<string | null>(null)
  return (
    <section className="grid gap-3">
      <h2 className="text-lg font-bold">{t('history')}</h2>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('version')}</TableHead>
              <TableHead>{t('date')}</TableHead>
              <TableHead>{t('by')}</TableHead>
              <TableHead>{t('note')}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((v) => (
              <Fragment key={v.id}>
                <TableRow>
                  <TableCell className="tabular-nums">
                    {v.locale.toUpperCase()} {v.version}
                  </TableCell>
                  <TableCell>{format.dateTime(new Date(v.created_at), { dateStyle: 'medium', timeStyle: 'short' })}</TableCell>
                  <TableCell>{v.created_by_email ?? t('imported')}</TableCell>
                  <TableCell className="max-w-xs truncate">{v.note ?? ''}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-expanded={open === v.id}
                      aria-controls={`legal-version-${v.id}`}
                      onClick={() => setOpen(open === v.id ? null : v.id)}
                    >
                      {t('view')}
                    </Button>
                  </TableCell>
                </TableRow>
                {open === v.id && (
                  <TableRow id={`legal-version-${v.id}`}>
                    <TableCell colSpan={5} className="whitespace-normal">
                      <div dir={v.locale === 'ar' ? 'rtl' : 'ltr'} lang={v.locale} className="grid max-h-[60vh] gap-4 overflow-y-auto rounded-lg border border-border p-4">
                        <h3 className="text-xl font-bold">{v.title}</h3>
                        <LegalMarkdown text={v.body} headingClassName="text-lg font-bold" />
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}
