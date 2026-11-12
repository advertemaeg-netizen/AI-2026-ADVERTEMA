'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Clock, FileText, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { StateBadge, type BadgeVariant } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createTemplateAction } from '@/lib/actions/templates'
import {
  TEMPLATE_BODY_MAX,
  TEMPLATE_LANGUAGES,
  TEMPLATE_NAME_MAX,
  TEMPLATE_NAME_PATTERN,
  templateInputSchema,
  type ChannelTemplates,
  type TemplateCreateError,
  type TemplateLanguage,
  type TemplateStatus,
  type WhatsAppTemplate,
} from '@/lib/types/templates'

const STATUS_VARIANT: Record<TemplateStatus, BadgeVariant> = {
  approved: 'positive',
  pending: 'progress',
  rejected: 'critical',
  unavailable: 'quiet',
}

/** 'ar', 'en', and Meta's regional codes ('en_US') by their language */
function languageKey(code: string): TemplateLanguage | null {
  const base = code.split('_')[0]
  return (TEMPLATE_LANGUAGES as readonly string[]).includes(base) ? (base as TemplateLanguage) : null
}

export function TemplatesBoard({ clientId, lists, canManage }: { clientId: string; lists: ChannelTemplates[]; canManage: boolean }) {
  // Shown after a submission until the page is left: the wait is the part nobody expects
  const [submitted, setSubmitted] = useState(false)
  const t = useTranslations('templates')

  return (
    <div className="flex flex-col gap-8">
      {submitted && (
        <p role="status" className="flex items-start gap-2 rounded-lg border bg-muted/50 p-3 text-sm">
          <Clock className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('pendingNote')}
        </p>
      )}
      {lists.map((list) => (
        <ChannelSection
          key={list.channelId}
          clientId={clientId}
          list={list}
          // A channel's name only tells sections apart when there is more than one
          heading={lists.length > 1 ? list.channelName : null}
          canManage={canManage}
          onSubmitted={() => setSubmitted(true)}
        />
      ))}
    </div>
  )
}

function ChannelSection({
  clientId,
  list,
  heading,
  canManage,
  onSubmitted,
}: {
  clientId: string
  list: ChannelTemplates
  heading: string | null
  canManage: boolean
  onSubmitted: () => void
}) {
  const t = useTranslations('templates')
  const [open, setOpen] = useState(false)

  return (
    <section className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {heading ? (
          <h2 dir="auto" className="min-w-0 truncate text-lg font-semibold">
            {heading}
          </h2>
        ) : (
          <span />
        )}
        {canManage && (
          <Button onClick={() => setOpen(true)}>
            <Plus className="size-4" aria-hidden />
            {t('create')}
          </Button>
        )}
      </div>

      {list.templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <FileText className="size-8" aria-hidden />
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.templates.map((template) => (
            <TemplateRow key={template.id} template={template} />
          ))}
        </ul>
      )}

      {canManage && (
        <CreateTemplateDialog
          clientId={clientId}
          channelId={list.channelId}
          open={open}
          onOpenChange={setOpen}
          onSubmitted={onSubmitted}
        />
      )}
    </section>
  )
}

function TemplateRow({ template }: { template: WhatsAppTemplate }) {
  const t = useTranslations('templates')
  const language = languageKey(template.language)
  const note = template.status === 'rejected' ? t('rejectedNote') : template.status === 'unavailable' ? t('unavailableNote') : null

  return (
    <li className="min-w-0 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* Wrapped, not cut: a name is an identifier, and every character of it counts */}
        <span dir="ltr" className="min-w-0 font-mono text-sm font-medium break-all">
          {template.name}
        </span>
        <span className="text-xs text-muted-foreground">{language ? t(`language.${language}`) : template.language}</span>
        <StateBadge state={template.status} variant={STATUS_VARIANT[template.status]} className="ms-auto">
          {t(`status.${template.status}`)}
        </StateBadge>
      </div>
      {template.body && (
        <p dir="auto" className="mt-2 line-clamp-4 text-sm whitespace-pre-wrap text-muted-foreground">
          {template.body}
        </p>
      )}
      {note && <p className="mt-3 border-t pt-3 text-sm">{note}</p>}
    </li>
  )
}

type Values = { name: string; language: TemplateLanguage; body: string }
const EMPTY: Values = { name: '', language: 'ar', body: '' }

export function CreateTemplateDialog({
  clientId,
  channelId,
  open,
  onOpenChange,
  onSubmitted,
}: {
  clientId: string
  channelId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmitted: () => void
}) {
  const t = useTranslations('templates')
  const tCommon = useTranslations('common')
  const tChannels = useTranslations('channels')
  const [values, setValues] = useState<Values>(EMPTY)
  const [nameInvalid, setNameInvalid] = useState(false)
  const [error, setError] = useState<TemplateCreateError | null>(null)
  const [isSaving, startSaving] = useTransition()

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((v) => ({ ...v, [key]: value }))

  function handleOpenChange(next: boolean) {
    if (isSaving) return
    if (next) {
      setValues(EMPTY)
      setNameInvalid(false)
      setError(null)
    }
    onOpenChange(next)
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError(null)
    const name = values.name.trim()
    const badName = !TEMPLATE_NAME_PATTERN.test(name)
    setNameInvalid(badName)
    if (badName) return
    const parsed = templateInputSchema.safeParse({ ...values, name })
    if (!parsed.success) {
      setError('validation')
      return
    }
    startSaving(async () => {
      const result = await createTemplateAction(clientId, channelId, parsed.data)
      if (result.ok) {
        onSubmitted()
        onOpenChange(false)
        return
      }
      setError(result.error)
    })
  }

  const formError =
    error === null || error === 'nameTaken'
      ? null
      : error === 'impersonating'
        ? tChannels('errors.impersonating')
        : t('error.createFailed')

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={handleSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{t('create')}</DialogTitle>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={nameInvalid || error === 'nameTaken'}>
              <FieldLabel htmlFor="template-name">{t('field.name')}</FieldLabel>
              <Input
                id="template-name"
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                value={values.name}
                maxLength={TEMPLATE_NAME_MAX}
                onChange={(e) => set('name', e.target.value)}
                aria-invalid={nameInvalid || error === 'nameTaken'}
                aria-describedby="template-name-hint"
              />
              {/* The rule sits by the field, not in an error afterwards: it turns red when broken */}
              <FieldDescription id="template-name-hint" className={nameInvalid ? 'text-destructive' : undefined}>
                {t('field.nameHint')}
              </FieldDescription>
              <FieldError>{error === 'nameTaken' ? t('error.nameTaken') : undefined}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="template-language">{t('field.language')}</FieldLabel>
              <Select value={values.language} onValueChange={(v) => set('language', v as TemplateLanguage)}>
                <SelectTrigger id="template-language" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TEMPLATE_LANGUAGES.map((code) => (
                    <SelectItem key={code} value={code}>
                      {t(`language.${code}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field>
              <FieldLabel htmlFor="template-body">{t('field.body')}</FieldLabel>
              <Textarea
                id="template-body"
                dir={values.language === 'ar' ? 'rtl' : 'ltr'}
                rows={6}
                value={values.body}
                maxLength={TEMPLATE_BODY_MAX}
                onChange={(e) => set('body', e.target.value)}
              />
              <FieldDescription dir="ltr" className="text-end tabular-nums">
                {values.body.length} / {TEMPLATE_BODY_MAX}
              </FieldDescription>
            </Field>
          </FieldGroup>

          {formError && (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSaving}>
                {tCommon('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSaving || !values.name.trim() || !values.body.trim()}>
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
