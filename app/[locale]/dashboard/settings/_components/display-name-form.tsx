'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateDisplayName } from '@/lib/actions/settings'
import { DISPLAY_NAME_MAX } from '@/lib/types/settings'

export function DisplayNameForm({ name, email, disabled }: { name: string; email: string; disabled: boolean }) {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [value, setValue] = useState(name)
  const [isPending, startTransition] = useTransition()
  const dirty = value.trim() !== name && value.trim().length > 0

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await updateDisplayName(value)
      if (result.ok) {
        toast.success(t('account.nameSaved'))
        router.refresh()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="grid content-start gap-2">
        <Label htmlFor="display-name">{t('account.name')}</Label>
        <Input
          id="display-name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="name"
          disabled={disabled}
          required
        />
      </div>
      <div className="grid content-start gap-2">
        <Label htmlFor="email">{t('account.email')}</Label>
        <Input id="email" value={email} dir="ltr" className="text-start" readOnly disabled />
        <p className="text-xs text-muted-foreground">{t('account.emailHint')}</p>
      </div>
      {!disabled && (
        <div className="sm:col-span-2">
          <Button type="submit" disabled={!dirty || isPending}>
            {tCommon('save')}
          </Button>
        </div>
      )}
    </form>
  )
}
