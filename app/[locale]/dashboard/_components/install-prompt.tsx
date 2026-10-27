'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { usePathname } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import {
  DESKTOP_MEDIA_QUERY,
  installPromptMode,
  isIosPlatform,
  isStandalone,
  readDismissed,
  writeDismissed,
  type BeforeInstallPromptEvent,
  type InstallPromptMode,
} from '@/lib/install-prompt'
import { CONVERSATION_THREAD } from './mobile-nav'

/**
 * Phones: a card at the bottom of the screen offering to put the app on the
 * home screen, once, until it is dismissed or the app is installed. It sits
 * directly above the bottom nav in the dashboard shell, and hides with it
 * inside a conversation (the reply box owns the bottom there); the nav carries
 * the home indicator's inset for both. The decisions are in
 * src/lib/install-prompt.ts.
 */
export function InstallPrompt() {
  const t = useTranslations('installPrompt')
  const pathname = usePathname()
  const [mode, setMode] = useState<InstallPromptMode>('hidden')
  // Android: the captured event, usable once
  const installEvent = useRef<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    if (readDismissed(window.localStorage) || isStandalone(window)) return

    const desktop = window.matchMedia(DESKTOP_MEDIA_QUERY)
    const ios = isIosPlatform(window.navigator)
    const decide = () =>
      setMode(
        installPromptMode({
          desktop: desktop.matches,
          standalone: false,
          dismissed: false,
          ios,
          hasInstallEvent: installEvent.current !== null,
        })
      )
    const onBeforeInstallPrompt = (event: Event) => {
      // Chrome's own mini-infobar is replaced by the card
      event.preventDefault()
      installEvent.current = event as BeforeInstallPromptEvent
      decide()
    }
    const onInstalled = () => {
      installEvent.current = null
      setMode('hidden')
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    desktop.addEventListener('change', decide)
    decide()
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
      desktop.removeEventListener('change', decide)
    }
  }, [])

  const dismiss = useCallback(() => {
    writeDismissed(window.localStorage)
    setMode('hidden')
  }, [])

  const install = useCallback(async () => {
    const event = installEvent.current
    if (!event) return
    // The event answers prompt() once; whatever the choice, the card goes for
    // this page view. A refusal in the native dialog is not a dismissal of the
    // card: Chrome fires the event again on a later visit, and so does the card.
    installEvent.current = null
    await event.prompt()
    await event.userChoice
    setMode('hidden')
  }, [])

  if (mode === 'hidden' || CONVERSATION_THREAD.test(pathname)) return null

  return (
    <div className="shrink-0 px-3 pb-3 md:hidden print:hidden">
      <section
        aria-label={t('title')}
        className="flex items-start gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-sm"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="grid gap-0.5">
            <h2 className="text-sm font-semibold">{t('title')}</h2>
            <p className="text-xs text-muted-foreground">{mode === 'ios' ? t('iosBody') : t('androidBody')}</p>
          </div>
          {mode === 'android' && (
            <Button size="sm" className="self-start" onClick={install}>
              {t('install')}
            </Button>
          )}
        </div>
        <Button variant="ghost" size="icon" className="-me-1 -mt-1" aria-label={t('dismiss')} onClick={dismiss}>
          <X className="size-4" />
        </Button>
      </section>
    </div>
  )
}
