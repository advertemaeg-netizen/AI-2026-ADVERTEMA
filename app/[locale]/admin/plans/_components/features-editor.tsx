'use client'

import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { PlanFeature } from '@/lib/types/subscription'

const MAX_FEATURES = 20

/** Editable feature lines: Arabic + English per line, add / remove / reorder. */
export function FeaturesEditor({
  features,
  onChange,
}: {
  features: PlanFeature[]
  onChange: (features: PlanFeature[]) => void
}) {
  const t = useTranslations('plans.form')

  function update(index: number, patch: Partial<PlanFeature>) {
    onChange(features.map((f, i) => (i === index ? { ...f, ...patch } : f)))
  }

  function move(index: number, by: -1 | 1) {
    const next = [...features]
    const [item] = next.splice(index, 1)
    next.splice(index + by, 0, item)
    onChange(next)
  }

  return (
    <div className="grid gap-2">
      {features.length === 0 && <p className="text-sm text-muted-foreground">{t('noFeatures')}</p>}
      {features.map((feature, index) => (
        <div key={index} className="flex items-center gap-2 rounded-md border p-2">
          <span className="w-5 shrink-0 text-center text-xs text-muted-foreground tabular-nums">{index + 1}</span>
          <div className="grid flex-1 gap-2 sm:grid-cols-2">
            <Input
              dir="rtl"
              lang="ar"
              value={feature.ar}
              onChange={(e) => update(index, { ar: e.target.value })}
              placeholder={t('featureAr')}
              aria-label={t('featureAr')}
              maxLength={120}
            />
            <Input
              dir="ltr"
              lang="en"
              value={feature.en}
              onChange={(e) => update(index, { en: e.target.value })}
              placeholder={t('featureEn')}
              aria-label={t('featureEn')}
              maxLength={120}
            />
          </div>
          <div className="flex shrink-0">
            <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t('moveUp')}>
              <ArrowUp />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={index === features.length - 1}
              onClick={() => move(index, 1)}
              aria-label={t('moveDown')}
            >
              <ArrowDown />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-destructive"
              onClick={() => onChange(features.filter((_, i) => i !== index))}
              aria-label={t('removeFeature')}
            >
              <Trash2 />
            </Button>
          </div>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={features.length >= MAX_FEATURES}
        onClick={() => onChange([...features, { ar: '', en: '' }])}
      >
        <Plus />
        {t('addFeature')}
      </Button>
    </div>
  )
}
