'use client'

import { useState, useTransition } from 'react'
import { Controller, useForm, useWatch, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Eye, EyeOff, Save, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  BOT_LANGUAGES,
  BOT_TIMEZONES,
  BOT_TONES,
  DEFAULT_BUSINESS_HOURS,
  MESSAGE_MAX,
  SYSTEM_PROMPT_MAX,
  WEEK_DAYS,
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
  const businessHours = useWatch({ control, name: 'business_hours' })

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
              {(['welcome_message', 'fallback_message'] as const).map((name) => (
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
                name="lead_qualification_enabled"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor="lead_qualification_enabled">{t('fields.leadQualification')}</FieldLabel>
                      <FieldDescription>{t('hints.leadQualification')}</FieldDescription>
                    </FieldContent>
                    <Switch
                      id="lead_qualification_enabled"
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

        {/* Business hours */}
        <Card>
          <CardHeader>
            <CardTitle>{t('sections.hours')}</CardTitle>
            <CardDescription>{t('sections.hoursDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="hours_enabled">{t('fields.hoursEnabled')}</FieldLabel>
                  <FieldDescription>{t('hints.hoursEnabled')}</FieldDescription>
                </FieldContent>
                <Switch
                  id="hours_enabled"
                  checked={!!businessHours?.enabled}
                  disabled={!canManage}
                  onCheckedChange={(enabled) =>
                    setValue(
                      'business_hours',
                      { ...(getValues('business_hours') ?? DEFAULT_BUSINESS_HOURS), enabled },
                      { shouldDirty: true }
                    )
                  }
                />
              </Field>

              {businessHours?.enabled && <BusinessHoursEditor control={control} disabled={!canManage} />}
            </FieldGroup>
          </CardContent>
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

function BusinessHoursEditor({
  control,
  disabled,
}: {
  control: Control<BotSettingsInput>
  disabled: boolean
}) {
  const t = useTranslations('botSettings')

  return (
    <>
      <Controller
        control={control}
        name="business_hours.timezone"
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="timezone">{t('fields.timezone')}</FieldLabel>
            <Select value={field.value} onValueChange={field.onChange} disabled={disabled}>
              <SelectTrigger id="timezone" className="w-full sm:w-64" dir="ltr">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BOT_TIMEZONES.map((zone) => (
                  <SelectItem key={zone} value={zone}>
                    {zone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
      />

      <div className="grid gap-2">
        {WEEK_DAYS.map((day) => (
          <div key={day} className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
            <Controller
              control={control}
              name={`business_hours.days.${day}.open`}
              render={({ field }) => (
                <label className="flex w-36 items-center gap-2 text-sm">
                  <Switch checked={field.value} onCheckedChange={field.onChange} disabled={disabled} />
                  {t(`days.${day}`)}
                </label>
              )}
            />
            <DayTimes control={control} day={day} disabled={disabled} />
          </div>
        ))}
      </div>
      <FieldDescription>{t('hints.overnight')}</FieldDescription>
    </>
  )
}

function DayTimes({
  control,
  day,
  disabled,
}: {
  control: Control<BotSettingsInput>
  day: (typeof WEEK_DAYS)[number]
  disabled: boolean
}) {
  const t = useTranslations('botSettings')
  const open = useWatch({ control, name: `business_hours.days.${day}.open` })

  if (!open) return <span className="text-sm text-muted-foreground">{t('closed')}</span>

  return (
    <div className="flex items-center gap-2 text-sm">
      {(['from', 'to'] as const).map((edge) => (
        <Controller
          key={edge}
          control={control}
          name={`business_hours.days.${day}.${edge}`}
          render={({ field, fieldState }) => (
            <label className="flex items-center gap-1.5">
              <span className="text-muted-foreground">{t(`hours.${edge}`)}</span>
              <Input
                {...field}
                type="time"
                dir="ltr"
                disabled={disabled}
                aria-invalid={fieldState.invalid}
                className="w-28"
              />
            </label>
          )}
        />
      ))}
    </div>
  )
}
