'use client'

import { useState, useTransition } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Eye, EyeOff, Save, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { updateBotSettings } from '@/lib/actions/bot-settings'
import { BOT_PRESET_NAMES, BOT_PRESETS, type BotPresetName } from '@/lib/constants/bot-presets'
import { Link } from '@/i18n/navigation'
import {
  BOOKING_MODES,
  BOT_LANGUAGES,
  BOT_TONES,
  MESSAGE_MAX,
  NAME_STRICTNESS,
  SYSTEM_PROMPT_MAX,
  botSettingsSchema,
  type BotSettingsInput,
} from '@/lib/types/bot-settings'
import { Playground } from '../../playground/_components/playground'

function temperatureLabel(value: number) {
  if (value < 0.35) return 'conservative'
  if (value < 0.7) return 'balanced'
  return 'creative'
}

export function BotSettingsForm({
  clientId,
  clientName,
  initialSettings,
  canManage,
}: {
  clientId: string
  clientName: string
  initialSettings: BotSettingsInput
  canManage: boolean
}) {
  const t = useTranslations('botSettings')
  const locale = useLocale()
  const dir = locale === 'ar' ? 'rtl' : 'ltr'
  const [showPreview, setShowPreview] = useState(false)
  const [isSaving, startSaving] = useTransition()

  const form = useForm<BotSettingsInput>({
    resolver: zodResolver(botSettingsSchema),
    defaultValues: initialSettings,
    disabled: !canManage,
  })
  const { control, handleSubmit, formState, getValues, setValue, reset } = form
  const welcomeMessage = useWatch({ control, name: 'welcome_message' })

  // zod messages are translation keys ('required', 'tooLong', 'invalidTime')
  const errorText = (message?: string) => (message ? t(`errors.${message}`) : undefined)

  function applyPreset(name: BotPresetName) {
    for (const [key, value] of Object.entries(BOT_PRESETS[name])) {
      setValue(key as keyof BotSettingsInput, value as never, { shouldDirty: true, shouldValidate: true })
    }
    toast.success(t('presets.applied', { preset: t(`presets.names.${name}`) }))
  }

  const onSubmit = handleSubmit((values) => {
    startSaving(async () => {
      const result = await updateBotSettings(clientId, values)
      if (result.ok) {
        reset(values) // new baseline for "unsaved changes"
        toast.success(t('toast.saved'))
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  })

  return (
    <div className={cn('grid items-start gap-6', showPreview && 'xl:grid-cols-[minmax(0,1fr)_400px]')}>
      <form onSubmit={onSubmit} className="grid gap-6" noValidate>
        {canManage && (
          <Card size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4" />
                {t('presets.title')}
              </CardTitle>
              <CardDescription>{t('presets.description')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {BOT_PRESET_NAMES.map((name) => (
                <Button key={name} type="button" variant="outline" size="sm" onClick={() => applyPreset(name)}>
                  {t(`presets.names.${name}`)}
                </Button>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Personality & tone */}
        <Card>
          <CardHeader>
            <CardTitle>{t('sections.personality')}</CardTitle>
            <CardDescription>{t('sections.personalityDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Controller
                control={control}
                name="system_prompt"
                render={({ field, fieldState }) => (
                  <Field data-invalid={fieldState.invalid}>
                    <FieldLabel htmlFor="system_prompt">{t('fields.systemPrompt')}</FieldLabel>
                    <Textarea
                      {...field}
                      id="system_prompt"
                      rows={10}
                      maxLength={SYSTEM_PROMPT_MAX}
                      aria-invalid={fieldState.invalid}
                      className="min-h-48"
                    />
                    <FieldDescription>
                      {t('hints.systemPrompt')} ({field.value.length}/{SYSTEM_PROMPT_MAX})
                    </FieldDescription>
                    <FieldError>{errorText(fieldState.error?.message)}</FieldError>
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="tone"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="tone">{t('fields.tone')}</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={field.disabled}>
                      <SelectTrigger id="tone" className="w-full sm:w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BOT_TONES.map((tone) => (
                          <SelectItem key={tone} value={tone}>
                            {t(`tones.${tone}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        {/* Messages */}
        <Card>
          <CardHeader>
            <CardTitle>{t('sections.messages')}</CardTitle>
            <CardDescription>{t('sections.messagesDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {(['welcome_message', 'fallback_message', 'service_unavailable_message'] as const).map((name) => (
                <Controller
                  key={name}
                  control={control}
                  name={name}
                  render={({ field, fieldState }) => (
                    <Field data-invalid={fieldState.invalid}>
                      <FieldLabel htmlFor={name}>{t(`fields.${name}`)}</FieldLabel>
                      <Textarea
                        {...field}
                        id={name}
                        rows={name === 'welcome_message' ? 2 : 3}
                        maxLength={MESSAGE_MAX}
                        aria-invalid={fieldState.invalid}
                      />
                      <FieldDescription>{t(`hints.${name}`)}</FieldDescription>
                      <FieldError>{errorText(fieldState.error?.message)}</FieldError>
                    </Field>
                  )}
                />
              ))}
            </FieldGroup>
          </CardContent>
        </Card>

        {/* Behaviour */}
        <Card>
          <CardHeader>
            <CardTitle>{t('sections.behavior')}</CardTitle>
            <CardDescription>{t('sections.behaviorDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Controller
                control={control}
                name="booking_mode"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="booking_mode">{t('fields.bookingMode')}</FieldLabel>
                    {/* Unset follows the opening hours: shown as its own choice, saved as null */}
                    <Select
                      value={field.value ?? 'auto'}
                      onValueChange={(value) => field.onChange(value === 'auto' ? null : value)}
                      disabled={field.disabled}
                    >
                      <SelectTrigger id="booking_mode" className="w-full sm:w-96">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['auto', ...BOOKING_MODES] as const).map((mode) => (
                          <SelectItem key={mode} value={mode}>
                            {t(`bookingModes.${mode}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>{t('hints.bookingMode')}</FieldDescription>
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="name_strictness"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="name_strictness">{t('fields.nameStrictness')}</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={field.disabled}>
                      <SelectTrigger id="name_strictness" className="w-full sm:w-96">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {NAME_STRICTNESS.map((strictness) => (
                          <SelectItem key={strictness} value={strictness}>
                            {t(`nameStrictness.${strictness}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldDescription>{t('hints.nameStrictness')}</FieldDescription>
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="auto_confirm_appointments"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="auto_confirm_appointments">{t('fields.autoConfirmAppointments')}</FieldLabel>
                      <FieldDescription>{t('hints.autoConfirmAppointments')}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id="auto_confirm_appointments"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                      disabled={field.disabled}
                    />
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="language"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="language">{t('fields.language')}</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={field.disabled}>
                      <SelectTrigger id="language" className="w-full sm:w-64">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BOT_LANGUAGES.map((language) => (
                          <SelectItem key={language} value={language}>
                            {t(`languages.${language}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="temperature"
                render={({ field }) => (
                  <Field>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor="temperature">{t('fields.temperature')}</FieldLabel>
                      <Badge variant="secondary">
                        {t(`temperature.${temperatureLabel(field.value)}`)} · {field.value.toFixed(2)}
                      </Badge>
                    </div>
                    <Slider
                      id="temperature"
                      dir={dir}
                      min={0}
                      max={1}
                      step={0.05}
                      value={[field.value]}
                      onValueChange={([value]) => field.onChange(value)}
                      disabled={field.disabled}
                      aria-label={t('fields.temperature')}
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{t('temperature.conservative')}</span>
                      <span>{t('temperature.balanced')}</span>
                      <span>{t('temperature.creative')}</span>
                    </div>
                  </Field>
                )}
              />
              <Controller
                control={control}
                name="max_response_length"
                render={({ field }) => (
                  <Field>
                    <div className="flex items-center justify-between gap-2">
                      <FieldLabel htmlFor="max_response_length">{t('fields.maxLength')}</FieldLabel>
                      <Badge variant="secondary">{t('maxLengthValue', { count: field.value })}</Badge>
                    </div>
                    <Slider
                      id="max_response_length"
                      dir={dir}
                      min={100}
                      max={2000}
                      step={50}
                      value={[field.value]}
                      onValueChange={([value]) => field.onChange(value)}
                      disabled={field.disabled}
                      aria-label={t('fields.maxLength')}
                    />
                    <FieldDescription>{t('hints.maxLength')}</FieldDescription>
                  </Field>
                )}
              />
            </FieldGroup>
          </CardContent>
        </Card>

        {/* Business hours: no longer edited here. Since 22 October 2026 each
            branch's hours decide a booking and are what the assistant states;
            an editor that still looked like it worked would decide nothing. */}
        <Card>
          <CardHeader>
            <CardTitle>{t('sections.hours')}</CardTitle>
            <CardDescription>
              <Link href={`/dashboard/clients/${clientId}/branches`} className="underline underline-offset-4 hover:text-foreground">
                {t('sections.hoursMoved')}
              </Link>
            </CardDescription>
          </CardHeader>
        </Card>

        <div className="sticky bottom-0 z-10 -mx-2 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-2 py-3 backdrop-blur">
          {formState.isDirty && (
            <span className="me-auto text-sm text-muted-foreground">{t('unsaved')}</span>
          )}
          <Button type="button" variant="outline" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
            {showPreview ? t('hidePreview') : t('preview')}
          </Button>
          {canManage && (
            <Button type="submit" disabled={!formState.isDirty || isSaving}>
              <Save data-icon="inline-start" />
              {isSaving ? t('saving') : t('save')}
            </Button>
          )}
        </div>
      </form>

      {showPreview && (
        <div className="grid gap-2 xl:sticky xl:top-8">
          <p className="text-xs text-muted-foreground">
            {canManage ? t('previewHint') : t('previewHintReadOnly')}
          </p>
          <Playground
            clientId={clientId}
            clientName={clientName}
            welcomeMessage={welcomeMessage}
            // Unsaved values, so edits can be tried before saving
            getSettingsOverride={canManage ? () => getValues() : undefined}
            compact
          />
        </div>
      )}
    </div>
  )
}

