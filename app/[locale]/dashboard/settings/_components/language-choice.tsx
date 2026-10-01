'use client'

import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const LOCALES = { ar: 'العربية', en: 'English' } as const

export function LanguageChoice() {
  const t = useTranslations('settings')
  const locale = useLocale()
  const pathname = usePathname()
  const router = useRouter()

  return (
    <div className="grid gap-2 sm:max-w-xs">
      <Label htmlFor="language">{t('account.language')}</Label>
      <Select value={locale} onValueChange={(next) => router.replace(pathname, { locale: next as keyof typeof LOCALES })}>
        <SelectTrigger id="language" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(LOCALES).map(([code, name]) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
