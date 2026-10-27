/**
 * The install-to-home-screen card's decisions, apart from the DOM so they can
 * be tested. The component (app/[locale]/dashboard/_components/install-prompt.tsx)
 * feeds it the browser's values.
 *
 * Two platforms, two cards, never unified:
 * - Android/Chrome fires `beforeinstallprompt`; the card holds that event and
 *   its button calls prompt(). The card is shown only once the event arrived.
 * - iOS has no such event. The card gives the Share → Add to Home Screen
 *   instructions and no button.
 */

/** Chrome's event; not in lib.dom because it is not a standard */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/**
 * ONE INSTALLED APP PER LOCALE. The dashboard lives at /ar/dashboard and
 * /en/dashboard (localePrefix "always"), so each locale has its own manifest,
 * whose start_url and scope are its dashboard, and its own registration of
 * the service worker with that same scope: Chrome offers the install prompt
 * only when a worker with a fetch handler controls the start_url. No trailing
 * slash: a scope of "/ar/dashboard/" would leave "/ar/dashboard" itself, the
 * start_url, uncontrolled.
 */
export const dashboardAppScope = (locale: string) => `/${locale}/dashboard`
export const manifestUrl = (locale: string) => `/manifest-${locale}.webmanifest`
/** public/sw.js: a fetch handler that passes every request to the network */
export const SERVICE_WORKER_URL = '/sw.js'

/** Where the dismissal is kept; the value is the ISO time of the dismissal */
export const INSTALL_PROMPT_DISMISSED_KEY = 'mudrik.install-prompt.dismissed'

/** Phones only: from md (768px, the mobile nav's breakpoint) the card is never shown */
export const DESKTOP_MEDIA_QUERY = '(min-width: 768px)'

/**
 * iOS by platform, not by browser name: iPhones and iPods report themselves;
 * an iPad in its default desktop mode reports "MacIntel", and only the touch
 * points tell it from a Mac.
 */
export function isIosPlatform(nav: { platform?: string; maxTouchPoints?: number }): boolean {
  const platform = nav.platform ?? ''
  if (/^(iPhone|iPad|iPod)/.test(platform)) return true
  return platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1
}

/** Already installed: opened from the home screen (display-mode on Android, navigator.standalone on iOS) */
export function isStandalone(win: {
  matchMedia?: (query: string) => { matches: boolean }
  // Safari's navigator.standalone is not in lib.dom's Navigator
  navigator: Navigator | { standalone?: boolean }
}): boolean {
  if ((win.navigator as { standalone?: boolean }).standalone === true) return true
  try {
    return win.matchMedia?.('(display-mode: standalone)').matches ?? false
  } catch {
    return false
  }
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

/**
 * localStorage can be missing, full, or forbidden (private windows, blocked
 * site data), and then reading or writing throws. A failed read means "not
 * dismissed"; a failed write means the card comes back next time, which is the
 * lesser harm.
 */
export function readDismissed(storage: StorageLike | undefined | null): boolean {
  try {
    return storage?.getItem(INSTALL_PROMPT_DISMISSED_KEY) != null
  } catch {
    return false
  }
}

export function writeDismissed(storage: StorageLike | undefined | null, now: Date = new Date()): void {
  try {
    storage?.setItem(INSTALL_PROMPT_DISMISSED_KEY, now.toISOString())
  } catch {
    // Nothing to do: the card is hidden for this page view either way
  }
}

export type InstallPromptMode = 'hidden' | 'ios' | 'android'

/**
 * Which card to show, if any. Order matters only for the hidden reasons, which
 * all win over both platforms.
 */
export function installPromptMode(input: {
  desktop: boolean
  standalone: boolean
  dismissed: boolean
  ios: boolean
  /** Android: `beforeinstallprompt` was captured, so the button can act */
  hasInstallEvent: boolean
}): InstallPromptMode {
  if (input.desktop || input.standalone || input.dismissed) return 'hidden'
  if (input.ios) return 'ios'
  return input.hasInstallEvent ? 'android' : 'hidden'
}
