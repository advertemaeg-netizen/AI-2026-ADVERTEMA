import { getRequestConfig } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import { routing } from './routing'

export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = hasLocale(routing.locales, requested)
    ? requested
    : routing.defaultLocale

  return {
    locale,
    // All dates are shown in Cairo time, wherever the server or browser is
    timeZone: 'Africa/Cairo',
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})