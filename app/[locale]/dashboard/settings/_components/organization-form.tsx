'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { useRouter } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { updateOrganizationName } from '@/lib/actions/settings'
import { ORGANIZATION_NAME_MAX, type OrganizationSettings } from '@/lib/types/settings'

export function OrganizationForm({ organization, disabled }: { organization: OrganizationSettings; disabled: boolean }) {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [value, setValue] = useState(organization.name)
  const [isPending, startTransition] = useTransition()
  const dirty = value.trim() !== organization.name && value.trim().length >= 2

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await updateOrganizationName(value)
      if (result.ok) {
        toast.success(t('organization.nameSaved'))
        router.refresh()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
      <div className="grid content-start gap-2">
        <Label htmlFor="organization-name">{t('organization.name')}</Label>
        <Input
          id="organization-name"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          minLength={2}
          maxLength={ORGANIZATION_NAME_MAX}
          disabled={disabled}
          required
        />
      </div>
      <div className="grid content-start gap-2">
        <span className="text-sm font-medium">{t('organization.type')}</span>
        <Badge variant="secondary" className="w-fit">
          {t(`organization.types.${organization.org_type}`)}
        </Badge>
        <p className="text-xs text-muted-foreground">{t('organization.typeHint')}</p>
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
