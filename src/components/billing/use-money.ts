'use client'

import { useFormatter, useTranslations } from 'next-intl'

/** EGP amounts: "3,500" and "3,500 ج.م" (currency label from translations, never hardcoded prices). */
export function useMoney() {
  const format = useFormatter()
  const t = useTranslations('subscription')
  const amount = (value: number) => format.number(value, { maximumFractionDigits: 2 })
  return {
    amount,
    withCurrency: (value: number) => `${amount(value)} ${t('currency')}`,
  }
}
